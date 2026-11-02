import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentDraftMetadata, agentSendApprovals, messages } from "@/db/schema";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { loadMessageAttachmentContents } from "@/lib/email/attachments";
import { sendEmail } from "@/lib/email/send";
import { newId } from "@/lib/ids";
import type { SessionUser } from "@/lib/auth/types";
import type { AgentSendSnapshot } from "./types";
import type { AttachmentContent } from "@/lib/email/attachment-types";

async function sha256(value: ArrayBuffer | string) {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function currentDraft(env: CloudflareEnv, user: SessionUser, draftId: string) {
	const db = getDb(env);
	const [draft] = await db.select().from(messages).where(and(eq(messages.id, draftId), eq(messages.userId, user.id), eq(messages.status, "draft"))).limit(1);
	if (!draft?.mailboxId) throw new Error("Draft not found");
	const [metadata] = await db.select().from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, draftId)).limit(1);
	if (!metadata) throw new Error("Agent draft not found");
	await getAuthorizedSenderAddress(env, { userId: user.id, mailboxId: draft.mailboxId, from: draft.fromAddr });
	return { draft, metadata };
}

async function snapshot(env: CloudflareEnv, draft: typeof messages.$inferSelect, scheduledAt: Date | null): Promise<{ payload: AgentSendSnapshot; hash: string; contents: AttachmentContent[] }> {
	// Keep the verified bytes. Reloading mutable attachment membership after
	// approval would allow a concurrent edit to replace the reviewed files.
	const contents = await loadMessageAttachmentContents(env, draft.id);
	const attachments: AgentSendSnapshot["attachments"] = [];
	for (const file of contents) attachments.push({ id: file.storageId!, filename: file.filename,
		size: file.content.byteLength, digest: await sha256(file.content),
		type: file.type, disposition: file.disposition ?? "attachment", contentId: file.contentId ?? null });
	attachments.sort((a, b) => a.id.localeCompare(b.id));
	const payload: AgentSendSnapshot = {
		from: draft.fromAddr, to: draft.toAddr, cc: draft.ccAddr, bcc: draft.bccAddr,
		subject: draft.subject ?? "", text: draft.textBody, html: draft.htmlBody,
		inReplyTo: draft.inReplyTo, references: draft.references, threadId: draft.threadId,
		mailboxId: draft.mailboxId!, scheduledAt: scheduledAt?.toISOString() ?? null, attachments,
	};
	if (!payload.to.trim() || !payload.subject.trim() || !(payload.text?.trim() || payload.html?.trim())) throw new Error("Draft is incomplete");
	return { payload, hash: await sha256(JSON.stringify(payload)), contents };
}

export async function requestAgentSend(env: CloudflareEnv, user: SessionUser, draftId: string, expectedRevision: number, requestKeyId?: string) {
	const { draft, metadata } = await currentDraft(env, user, draftId);
	if (metadata.revision !== expectedRevision) throw new Error("Draft changed; reopen it for review");
	if (metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now()) throw new Error("Scheduled time has passed; update the draft before review");
	const [existing] = await getDb(env).select({ id: agentSendApprovals.id }).from(agentSendApprovals).where(and(eq(agentSendApprovals.draftId, draftId), inArray(agentSendApprovals.status, ["claimed", "sent", "unknown"]))).limit(1);
	if (existing) throw new Error("This draft has a delivery already in progress or awaiting reconciliation");
	const { payload, hash } = await snapshot(env, draft, metadata.scheduledAt);
	const id = newId("approval");
	const expiresAt = new Date(Date.now() + 15 * 60_000);
	await getDb(env).insert(agentSendApprovals).values({ id, draftId, mailboxId: draft.mailboxId!, userId: user.id, requestKeyId: requestKeyId ?? null, revision: expectedRevision, payloadHash: hash, expiresAt });
	return { approvalId: id, status: "pending_approval", expiresAt, snapshot: payload, reviewUrl: `/agent/review/${id}` };
}

export async function getAgentSendRequest(env: CloudflareEnv, user: SessionUser, approvalId: string) {
	const [approval] = await getDb(env).select().from(agentSendApprovals).where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.userId, user.id))).limit(1);
	if (!approval) throw new Error("Approval not found");
	let current: AgentSendSnapshot | null = null;
	let stale = false;
	if (approval.status === "pending") {
		try {
			const { draft, metadata } = await currentDraft(env, user, approval.draftId);
			const read = await snapshot(env, draft, metadata.scheduledAt);
			stale = metadata.revision !== approval.revision || read.hash !== approval.payloadHash || !!(metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now());
			if (!stale) current = read.payload;
		} catch { stale = true; }
	}
	return { approvalId, status: approval.status, draftId: approval.draftId, messageId: approval.messageId, expiresAt: approval.expiresAt, snapshot: current, stale };
}

export async function confirmAgentSend(env: CloudflareEnv, user: SessionUser, approvalId: string, publicOrigin?: string) {
	const db = getDb(env);
	const [approval] = await db.select().from(agentSendApprovals).where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.userId, user.id))).limit(1);
	if (!approval) throw new Error("Approval not found");
	if (approval.status !== "pending") return { status: approval.status, messageId: approval.messageId };
	if (approval.expiresAt < new Date()) {
		await db.update(agentSendApprovals).set({ status: "expired" }).where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.status, "pending")));
		throw new Error("Approval expired");
	}
	const { draft, metadata } = await currentDraft(env, user, approval.draftId);
	const current = await snapshot(env, draft, metadata.scheduledAt);
	if (metadata.revision !== approval.revision || current.hash !== approval.payloadHash) throw new Error("Draft changed; review it again");
	if (metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now()) throw new Error("Scheduled time has passed; update the draft before confirming");
	const claimed = await db.update(agentSendApprovals).set({ status: "claimed", claimedAt: new Date() }).where(and(
		eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.status, "pending"),
		sql`expires_at > ${Math.floor(Date.now() / 1000)}`,
		sql`exists (select 1 from agent_draft_metadata adm join messages m on m.id=adm.draft_id
			where adm.draft_id=${draft.id} and adm.revision=${approval.revision} and m.status='draft')`,
		sql`not exists (select 1 from agent_send_approvals other where other.draft_id=${draft.id}
			and other.status in ('claimed','sent','unknown'))`,
	)).returning({ id: agentSendApprovals.id });
	if (!claimed.length) {
		const state = await getAgentSendRequest(env, user, approvalId);
		if (state.status === "pending") throw new Error("Draft changed or another delivery is in progress; review it again");
		return state;
	}
	let result: Awaited<ReturnType<typeof sendEmail>>;
	try {
		result = await sendEmail(env, {
			userId: user.id, mailboxId: draft.mailboxId!, from: draft.fromAddr, to: draft.toAddr,
			cc: draft.ccAddr || undefined, bcc: draft.bccAddr || undefined,
			subject: draft.subject || "", text: draft.textBody || undefined, html: draft.htmlBody || undefined,
		inReplyTo: draft.inReplyTo, references: draft.references, threadId: draft.threadId,
			attachments: current.contents,
			scheduledAt: metadata.scheduledAt ?? undefined,
			publicOrigin,
		});
	} catch (error) {
		await db.update(agentSendApprovals).set({ status: "unknown" })
			.where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.status, "claimed")))
			.catch(() => console.error("Agent delivery status needs reconciliation"));
		throw new Error(`Delivery outcome needs review: ${error instanceof Error ? error.message : "provider error"}`);
	}
	// Delivery (or durable scheduled acceptance) succeeded. Local status/cleanup
	// failures must never relabel that known outcome as an uncertain send.
	let recorded = false;
	for (let attempt = 0; attempt < 2 && !recorded; attempt++) {
		try {
			await db.update(agentSendApprovals).set({ status: "sent", messageId: result.messageId })
				.where(and(eq(agentSendApprovals.id, approvalId), inArray(agentSendApprovals.status, ["claimed", "sent"])));
			recorded = true;
		} catch { /* One bounded retry also handles a lost successful response. */ }
	}
	if (!recorded) console.error("Confirmed agent delivery approval needs reconciliation");
	else await db.update(messages).set({ status: "trash" }).where(and(eq(messages.id, draft.id), eq(messages.status, "draft")))
		.catch(() => console.error("Confirmed agent delivery draft cleanup deferred"));
	return { status: "sent", messageId: result.messageId, scheduled: !!result.scheduled };
}
