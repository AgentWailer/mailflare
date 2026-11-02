import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import type {
	AttachmentContent,
	AttachmentMetadata,
	AttachmentStorageInput,
	StoredAttachment,
} from "./attachment-types";

export const MAX_ATTACHMENT_SIZE = 25_000_000;
export const MAX_TOTAL_ATTACHMENT_SIZE = 25_000_000;
export const MAX_ATTACHMENT_COUNT = 10;

export function decodeBase64Content(content: string): ArrayBuffer {
	const binary = atob(content.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

export function normalizeAttachmentContent(
	content: ArrayBuffer | Uint8Array | string,
	encoding?: "base64" | "utf8",
): ArrayBuffer {
	if (content instanceof ArrayBuffer) return content;
	if (content instanceof Uint8Array) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
	}
	if (encoding === "base64") return decodeBase64Content(content);
	return new TextEncoder().encode(content).buffer;
}

function sanitizeFilename(filename: string): string {
	const normalized = filename.trim().replace(/[/\\\0]/g, "_");
	return normalized || "attachment";
}

function attachmentSize(content: ArrayBuffer | Blob): number {
	return content instanceof Blob ? content.size : content.byteLength;
}

export function validateAttachments(attachments: AttachmentStorageInput[]): void {
	if (attachments.length > MAX_ATTACHMENT_COUNT) {
		throw new Error(`A message can include at most ${MAX_ATTACHMENT_COUNT} attachments`);
	}

	let totalSize = 0;
	for (const attachment of attachments) {
		const size = attachmentSize(attachment.content);
		if (size > MAX_ATTACHMENT_SIZE) {
			throw new Error(`${attachment.filename} exceeds the 25 MB attachment limit`);
		}
		totalSize += size;
	}

	if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
		throw new Error("Attachments exceed the 25 MB total limit");
	}
}

export async function storeMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
	attachments: AttachmentStorageInput[],
	options?: { validate?: boolean; persist?: boolean },
): Promise<StoredAttachment[]> {
	if (options?.validate !== false) validateAttachments(attachments);
	const db = getDb(env);
	const stored: StoredAttachment[] = [];

	try {
		for (const attachment of attachments) {
			const size = attachmentSize(attachment.content);
			const id = newId("att");
			const filename = sanitizeFilename(attachment.filename);
			const r2Key = `attachments/${messageId}/${id}/${filename}`;
			const disposition = attachment.disposition ?? "attachment";

			await env.BUCKET.put(r2Key, attachment.content, {
				httpMetadata: { contentType: attachment.type },
				customMetadata: { filename, messageId },
			});
			stored.push({
				id,
				messageId,
				filename,
				type: attachment.type,
				size,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
			if (options?.persist !== false) await db.insert(messageAttachments).values({
				id,
				messageId,
				filename,
				contentType: attachment.type,
				size,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
		}
	} catch (error) {
		await cleanupStoredAttachments(env, stored);
		throw error;
	}

	return stored;
}

/** Remove only files created by an interrupted copy/upload, never source objects. */
export async function cleanupStoredAttachments(env: CloudflareEnv, stored: StoredAttachment[]) {
	if (!stored.length) return;
	await getDb(env).delete(messageAttachments).where(inArray(messageAttachments.id, stored.map(file => file.id)));
	await Promise.allSettled(stored.map(file => env.BUCKET.delete(file.r2Key)));
}

/** A lost batch response may hide a committed edit. Never remove published files. */
export async function cleanupUnpublishedAttachments(env: CloudflareEnv, stored: StoredAttachment[]) {
	if (!stored.length) return;
	let published: { id: string }[];
	try { published = await getDb(env).select({ id: messageAttachments.id }).from(messageAttachments).where(inArray(messageAttachments.id, stored.map(file => file.id))); }
	catch { return; } // Retaining an orphan is safer than deleting a possibly committed file.
	const ids = new Set(published.map(file => file.id));
	await Promise.allSettled(stored.filter(file => !ids.has(file.id)).map(file => env.BUCKET.delete(file.r2Key)));
}

export class MissingAttachmentError extends Error {
	constructor(readonly filename: string) { super(`Attachment unavailable: ${filename}. Retry or attach the file again before sending.`); this.name = "MissingAttachmentError"; }
}

/**
 * Duplicate a message's attachments onto another message (a forward draft).
 * R2 keys are unique per row, so the objects are copied rather than shared,
 * which keeps deleting the draft from touching the original.
 */
export async function copyMessageAttachments(
	env: CloudflareEnv,
	fromMessageId: string,
	toMessageId: string,
): Promise<AttachmentMetadata[]> {
	const db = getDb(env);
	const rows = await db.select().from(messageAttachments).where(and(eq(messageAttachments.messageId, fromMessageId), isNull(messageAttachments.trashedAt)));
	const copied: StoredAttachment[] = [];
	try {
		for (const row of rows) {
			const object = await env.BUCKET.get(row.r2Key);
			if (!object) throw new MissingAttachmentError(row.filename);
			const id = newId("att");
			const r2Key = `attachments/${toMessageId}/${id}/${row.filename}`;
			await env.BUCKET.put(r2Key, object.body, {
				httpMetadata: { contentType: row.contentType },
				customMetadata: { filename: row.filename, messageId: toMessageId },
			});
			copied.push({ id, messageId: toMessageId, filename: row.filename, type: row.contentType,
				size: row.size, disposition: row.disposition as "attachment" | "inline", contentId: row.contentId, r2Key });
			await db.insert(messageAttachments).values({ id, messageId: toMessageId, filename: row.filename,
				contentType: row.contentType, size: row.size, disposition: row.disposition, contentId: row.contentId, r2Key });
		}
	} catch (error) {
		await cleanupStoredAttachments(env, copied);
		throw error;
	}
	return copied.map(file => ({ id: file.id, messageId: file.messageId, filename: file.filename, type: file.type, size: file.size, disposition: file.disposition, contentId: file.contentId }));
}

/** Attachments with their bytes, for handing a draft's files to the send path. */
export async function loadMessageAttachmentContents(
	env: CloudflareEnv,
	messageId: string,
): Promise<AttachmentContent[]> {
	const db = getDb(env);
	const rows = await db.select().from(messageAttachments).where(and(eq(messageAttachments.messageId, messageId), isNull(messageAttachments.trashedAt)));
	if (rows.length > MAX_ATTACHMENT_COUNT || rows.reduce((total, row) => total + row.size, 0) > MAX_TOTAL_ATTACHMENT_SIZE) throw new Error("Attachments exceed the supported send size or count limit");
	const result: AttachmentContent[] = [];
	let bytes = 0;
	for (const row of rows) {
		const object = await env.BUCKET.get(row.r2Key);
		if (!object) throw new MissingAttachmentError(row.filename);
		if (object.size > MAX_ATTACHMENT_SIZE || bytes + object.size > MAX_TOTAL_ATTACHMENT_SIZE) throw new Error("Attachments exceed the supported send size limit");
		const content = await object.arrayBuffer();
		bytes += content.byteLength;
		if (bytes > MAX_TOTAL_ATTACHMENT_SIZE || content.byteLength > MAX_ATTACHMENT_SIZE) throw new Error("Attachments exceed the supported send size limit");
		result.push({
			storageId: row.id,
			filename: row.filename,
			type: row.contentType,
			content,
			disposition: row.disposition as "attachment" | "inline",
			contentId: row.contentId,
		});
	}
	return result;
}

/** Remove one attachment (row and object). Returns false when it is not on that message. */
export async function deleteMessageAttachment(
	env: CloudflareEnv,
	messageId: string,
	attachmentId: string,
): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db
		.select({ r2Key: messageAttachments.r2Key })
		.from(messageAttachments)
		.where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.messageId, messageId)))
		.limit(1);
	if (!row) return false;
	await db.delete(messageAttachments).where(eq(messageAttachments.id, attachmentId));
	await env.BUCKET.delete(row.r2Key);
	return true;
}

/** Remove every attachment object of a message; the rows cascade with the message row. */
export async function deleteMessageAttachmentObjects(env: CloudflareEnv, messageId: string): Promise<void> {
	const db = getDb(env);
	const rows = await db
		.select({ r2Key: messageAttachments.r2Key })
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, messageId));
	await Promise.all(rows.map((row) => env.BUCKET.delete(row.r2Key)));
}

export async function listMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
): Promise<AttachmentMetadata[]> {
	const db = getDb(env);
	const rows = await db
		.select()
		.from(messageAttachments)
		.where(and(eq(messageAttachments.messageId, messageId), isNull(messageAttachments.trashedAt)));

	return rows.map((attachment) => ({
		id: attachment.id,
		messageId: attachment.messageId,
		filename: attachment.filename,
		type: attachment.contentType,
		size: attachment.size,
		disposition: attachment.disposition as "attachment" | "inline",
		contentId: attachment.contentId,
	}));
}

export async function getAttachmentForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	attachmentId: string,
) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message) return null;

	if (message.mailboxId) {
		const access = await getMailboxAccessLevel(db, user, message.mailboxId);
		if (!access?.canRead) return null;
	} else if (message.userId !== user.id) {
		return null;
	}

	const [attachment] = await db
		.select()
		.from(messageAttachments)
		.where(
			and(
				eq(messageAttachments.id, attachmentId),
				eq(messageAttachments.messageId, messageId),
				isNull(messageAttachments.trashedAt),
			),
		)
		.limit(1);
	if (!attachment) return null;

	const object = await env.BUCKET.get(attachment.r2Key);
	if (!object) return null;
	return { attachment, object };
}
