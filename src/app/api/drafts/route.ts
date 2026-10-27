import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { readJsonBody } from "@/lib/http/request";
import { copyMessageAttachments } from "@/lib/email/attachments";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import type { DraftPayload } from "./types";
import { getDraftSender } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const db = getDb(env);
	const conditions = [
		eq(messages.userId, user.id),
		eq(messages.direction, "outbound" as const),
		eq(messages.status, "draft"),
	];
	if (mailboxId) conditions.push(eq(messages.mailboxId, mailboxId));

	const rows = await db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt))
		.limit(100);

	return NextResponse.json({ drafts: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let input: DraftPayload;
	try {
		input = await readJsonBody<DraftPayload>(request, 1024 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid draft request" }, { status });
	}
	const db = getDb(env);
	const sender = await getDraftSender(env, user.id, input);
	if ("error" in sender) {
		return NextResponse.json({ error: sender.error }, { status: 403 });
	}
	// Forwarding: the source must be readable by this user before its files are copied.
	let forwardSourceId: string | null = null;
	if (input.forwardOfMessageId) {
		const [source] = await db
			.select({ id: messages.id, mailboxId: messages.mailboxId })
			.from(messages)
			.where(eq(messages.id, input.forwardOfMessageId))
			.limit(1);
		const sourceAccess = source?.mailboxId ? await getMailboxAccessLevel(db, user, source.mailboxId) : null;
		if (!source || !sourceAccess?.canRead) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}
		forwardSourceId = source.id;
	}

	if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.requestId) || input.forwardOfMessageId)) {
		return NextResponse.json({ error: "Invalid draft request ID" }, { status: 400 });
	}
	// User-scoped deterministic ID makes a lost creation response safe to retry.
	const digest = input.requestId ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${user.id}:${input.requestId}`)) : null;
	const draftId = digest ? `msg_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}` : newId("msg");
	if (digest) {
		const [existing] = await db.select({ id: messages.id, status: messages.status }).from(messages).where(and(eq(messages.id, draftId), eq(messages.userId, user.id))).limit(1);
		if (existing) return existing.status === "draft" ? NextResponse.json({ draft: { id: existing.id, reused: true } }) : NextResponse.json({ error: "Draft already completed" }, { status: 409 });
	}
	const text = input.text ?? "";
	const html = input.html ?? "";

	const inserted = await db.insert(messages).values({
		id: draftId,
		userId: user.id,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: input.to ?? "",
		ccAddr: input.cc || null,
		bccAddr: input.bcc || null,
		subject: input.subject ?? null,
		snippet: buildSnippet(text || null, html || null),
		textBody: text || null,
		htmlBody: html || null,
		status: "draft",
		read: true,
		inReplyTo: input.inReplyTo || null,
		references: input.references || null,
		threadId: input.threadId || null,
	}).onConflictDoNothing().returning({ id: messages.id });
	if (!inserted.length) {
		const [existing] = await db.select({ status: messages.status }).from(messages).where(and(eq(messages.id, draftId), eq(messages.userId, user.id))).limit(1);
		return existing?.status === "draft" ? NextResponse.json({ draft: { id: draftId, reused: true } }) : NextResponse.json({ error: "Draft already completed" }, { status: 409 });
	}

	const attachments = forwardSourceId ? await copyMessageAttachments(env, forwardSourceId, draftId) : [];
	return NextResponse.json({ draft: { id: draftId, attachments } });
}
