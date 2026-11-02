import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";

export async function POST(
	_request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, _request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	let desired: boolean | undefined;
	try {
		const body = await readJsonBody<unknown>(_request, 1024);
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("Invalid star state");
		const value = (body as { starred?: unknown }).starred;
		if (value !== undefined && typeof value !== "boolean") throw new SyntaxError("Invalid star state");
		desired = value;
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Request too large" }, { status: 413 });
		if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid star state" }, { status: 400 });
		throw error;
	}

	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, starred: messages.starred })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	// Empty-body callers keep their previous toggle behavior; current clients send a target state.
	const starred = desired ?? !message.starred;
	if (starred !== message.starred) await db.update(messages).set({ starred }).where(eq(messages.id, message.id));
	return NextResponse.json({ starred });
}
