import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { normalizeMessageId } from "@/lib/email/thread-lookup";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { REFINE_HISTORY_LIMIT } from "./refine-input";
import type { RefineInput } from "./refine-input";
import { RefineError } from "./refine-error";

const HISTORY_FIELDS = {
	id: messages.id, threadId: messages.threadId, from: messages.fromAddr, to: messages.toAddr,
	cc: messages.ccAddr, subject: messages.subject, date: messages.createdAt,
	text: messages.textBody, html: messages.htmlBody,
};

/** Read every message in this conversation, with mailbox access checked before reading content. */
export async function replyHistory(db: ReturnType<typeof getDb>, user: SessionUser, input: RefineInput) {
	const context = input.replyContext;
	if (!context) throw new RefineError("history_missing", 400);
	const mailboxId = context.mailboxId ?? input.mailboxId;
	if (!(await getMailboxAccessLevel(db, user, mailboxId))?.canRead) throw new RefineError("forbidden", 403);
	// Unsent drafts (including other users' drafts) are never part of the conversation.
	const scope = and(eq(messages.mailboxId, mailboxId), notInArray(messages.status, ["draft", "queued", "sending", "failed", "scheduled"]));
	let threadId = context.threadId;
	let anchor: Awaited<ReturnType<typeof findAnchor>> | undefined;
	async function findAnchor(messageId: string) {
		const [row] = await db.select(HISTORY_FIELDS).from(messages).where(and(scope, inArray(messages.providerMessageId, [messageId, `<${messageId}>`]))).orderBy(asc(messages.createdAt), asc(messages.id)).limit(1);
		return row;
	}
	if (context.inReplyTo) {
		const messageId = normalizeMessageId(context.inReplyTo);
		if (!messageId) throw new RefineError("history_missing", 404);
		anchor = await findAnchor(messageId);
		if (!anchor || threadId && threadId !== (anchor.threadId ?? messageId)) throw new RefineError("history_missing", 404);
		// Legacy reply drafts use the parent's Message-ID as a thread key even if it has none.
		threadId = anchor.threadId ?? undefined;
	}
	if (!threadId && !anchor) {
		if (!context.quotedText?.trim()) throw new RefineError("history_missing", 404);
		return [{ text: context.quotedText }];
	}
	const history: Array<{ from: string; to: string; cc: string | null; subject: string | null; date: string; text: string }> = [];
	let size = 0;
	let hasText = false;
	for (let offset = 0; ; offset += 50) {
		const rows = threadId ? await db.select(HISTORY_FIELDS).from(messages).where(and(scope, eq(messages.threadId, threadId))).orderBy(asc(messages.createdAt), asc(messages.id)).limit(50).offset(offset) : [anchor!];
		for (const row of rows) {
			const text = row.text?.trim() || htmlToReadableText(row.html).trim();
			hasText ||= !!text;
			const item = { from: row.from, to: row.to, cc: row.cc, subject: row.subject, date: row.date.toISOString(), text };
			size += JSON.stringify(item).length;
			// Refuse an oversized history rather than quietly dropping earlier messages.
			if (size > REFINE_HISTORY_LIMIT) throw new RefineError("history_too_long", 413);
			history.push(item);
		}
		if (!threadId || rows.length < 50) break;
	}
	if (!hasText) throw new RefineError("history_missing", 404);
	return history;
}
