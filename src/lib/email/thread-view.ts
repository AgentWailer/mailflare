import { and, asc, eq, getTableColumns, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { getContactAvatarMap, getContactDisplayNameMap } from "@/lib/contacts/service";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";

/**
 * The conversation a message belongs to: every stored message in the same
 * mailbox sharing its thread id, oldest first. Drafts and trashed messages are
 * left out, matching what threaded clients show. Only headers/attachment metadata
 * come along: a collapsed conversation must not materialize 200 full HTML bodies.
 * The browser loads each body through the authorized detail endpoint on expansion.
 */
export class ThreadBodyLimitError extends Error {}
const LEGACY_THREAD_BODY_BYTES = 4 * 1024 * 1024;

export async function getMessageThreadForUser(env: CloudflareEnv, user: SessionUser, messageId: string, includeBodies = false) {
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, userId: messages.userId, threadId: messages.threadId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Exclude bodies and internal storage pointers from the SQL projection.
	const { htmlBody: _html, textBody: _text, rawR2Key: _raw, ...headers } = getTableColumns(messages);
	const rows = message.threadId
		? await db
				.select(headers)
				.from(messages)
				.where(
					and(
						eq(messages.mailboxId, message.mailboxId),
						eq(messages.threadId, message.threadId),
						notInArray(messages.status, ["draft", "trash"]),
					),
				)
				.orderBy(asc(messages.createdAt))
				.limit(200)
		: await db.select(headers).from(messages).where(eq(messages.id, messageId)).limit(1);

	const ids = rows.map((row) => row.id);
	const bodies = new Map<string, {textBody:string|null;htmlBody:string|null}>();
	// Browsers running an older cached app still receive the old body fields.
	// Estimate their total inside D1 first, so compatibility cannot allocate an
	// unbounded body/result/JSON combination in this isolate.
	if (includeBodies) {
		let bytes = 0;
		for (let offset = 0; offset < ids.length; offset += 80) {
			const [total] = await db.select({ bytes: sql<number>`coalesce(sum(coalesce(length(CAST(${messages.textBody} AS BLOB)),0)+coalesce(length(CAST(${messages.htmlBody} AS BLOB)),0)),0)` }).from(messages).where(inArray(messages.id, ids.slice(offset, offset + 80)));
			bytes += Number(total?.bytes ?? 0);
			if (bytes > LEGACY_THREAD_BODY_BYTES) throw new ThreadBodyLimitError("Reload Mailflare to load this conversation in smaller parts");
		}
		for (let offset = 0; offset < ids.length; offset += 80) {
			const page = await db.select({ id: messages.id, textBody: messages.textBody, htmlBody: messages.htmlBody }).from(messages).where(inArray(messages.id, ids.slice(offset, offset + 80)));
			for (const body of page) bodies.set(body.id, body);
		}
	}
	const attachmentRows: Array<{id:string;messageId:string;filename:string;type:string;size:number;disposition:string;contentId:string|null}> = [];
	for (let offset = 0; offset < ids.length; offset += 80) {
		attachmentRows.push(...await db
				.select({
					id: messageAttachments.id,
					messageId: messageAttachments.messageId,
					filename: messageAttachments.filename,
					type: messageAttachments.contentType,
					size: messageAttachments.size,
					disposition: messageAttachments.disposition,
					contentId: messageAttachments.contentId,
				})
				.from(messageAttachments)
				.where(and(inArray(messageAttachments.messageId, ids.slice(offset, offset + 80)), isNull(messageAttachments.trashedAt))));
	}
	const attachmentsByMessage = new Map<string, typeof attachmentRows>();
	for (const attachment of attachmentRows) {
		const list = attachmentsByMessage.get(attachment.messageId) ?? [];
		list.push(attachment);
		attachmentsByMessage.set(attachment.messageId, list);
	}

	const contactMap = await getContactDisplayNameMap(
		env,
		message.userId,
		rows.flatMap((row) => [row.fromAddr, getFirstEmailAddressEntry(row.toAddr)]),
	);
	const contactAvatarMap = await getContactAvatarMap(
		env,
		message.userId,
		rows.map((row) => row.fromAddr),
	);

	return {
		threadId: message.threadId,
		messages: rows.map((row) => ({
			...row,
			textBody: bodies.get(row.id)?.textBody ?? null,
			htmlBody: bodies.get(row.id)?.htmlBody ?? null,
			bodyLoaded: includeBodies,
			fromContactName: contactMap.get(normalizeEmailAddress(row.fromAddr)) ?? null,
			fromContactHasAvatar: contactAvatarMap.get(normalizeEmailAddress(row.fromAddr)) ?? false,
			toContactName: contactMap.get(normalizeEmailAddress(getFirstEmailAddressEntry(row.toAddr))) ?? null,
			attachments: attachmentsByMessage.get(row.id) ?? [],
		})),
	};
}
