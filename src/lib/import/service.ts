import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveThreadId } from "@/lib/email/threading";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { newId } from "@/lib/ids";
import { getImportMessagePlacement } from "./destination";
import { resolveTransactionMail } from "@/lib/mail-sorting/routine";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import type { ImportDestination } from "./destination-types";
import type { ImportMailboxResult, ImportMessageInput } from "./types";
import { ImportMessageError } from "./errors";

export async function importMessagesToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		messages: ImportMessageInput[];
	},
): Promise<ImportMailboxResult> {
	const result: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	for (const message of input.messages) {
		try {
			const imported = await importMessageToMailbox(env, {
				userId: input.userId,
				mailboxId: input.mailboxId,
				destination: input.destination,
				filename: message.filename,
				raw: message.raw,
				metadata: message.metadata,
			});
			if (imported.created) {
				result.imported += 1;
			} else {
				result.skipped += 1;
			}
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}
	return result;
}

export async function importMessageToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		filename: string;
		raw: ArrayBuffer;
		metadata?: ImportMessageInput["metadata"];
		/** Background jobs keep partially written messages hidden until objects and attachments are complete. */
		stagingId?: string;
		keepStaged?: boolean;
	},
): Promise<{ id: string; created: boolean }> {
	const parsed = await parseRawMime(input.raw).catch(error => { throw new ImportMessageError("Invalid MIME message; inspect the original message separately.", { cause: error }); });
	const db = getDb(env);
	const providerMessageId = parsed.messageId ?? input.metadata?.sourceKey ?? `import:${input.filename}:${input.raw.byteLength}`;

	const [existing] = await db
		.select({ id: messages.id, status: messages.status, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.providerMessageId, providerMessageId)))
		.limit(1);
	if (existing?.status === "importing") {
		if (!input.stagingId || existing.id !== input.stagingId) throw new Error("Another import is still writing this message");
		await deleteMessageWithObjects(env, db, existing.id, existing.rawR2Key);
	} else if (existing) return { id: existing.id, created: false };

	const messageId = input.stagingId ?? newId("msg");
	const rawR2Key = `imports/${messageId}.eml`;
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	const createdAt = input.metadata?.date ?? parsed.date ?? new Date();
	const placement = getImportMessagePlacement(input.destination);
	const direction = input.metadata?.direction ?? placement.direction;
	let category = input.metadata?.category ?? "primary";
	if (direction === "inbound" && (category === "primary" || category === "orders")) {
		const transaction = resolveTransactionMail({ sender: fromAddr, subject: parsed.subject,
			text: `${parsed.text ?? ""}\n${htmlToReadableText(parsed.html?.slice(0, 64000))}`.slice(0, 6000) });
		if (transaction && (category === "primary" || transaction.category === "invoices")) category = transaction.category;
	}

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: input.mailboxId,
		folderId: placement.folderId,
		direction,
		providerMessageId,
		fromAddr,
		toAddr,
		ccAddr: parsed.ccAddr,
		replyTo: parsed.replyTo,
		bccAddr: parsed.bccAddr,
		subject: parsed.subject,
		snippet: buildSnippet(parsed.text, parsed.html),
		textBody: parsed.text,
		htmlBody: parsed.html,
		rawR2Key,
		status: input.stagingId ? "importing" : placement.status,
		read: input.metadata?.read ?? direction === "outbound",
		starred: input.metadata?.starred ?? false,
		category,
		threadId: input.metadata?.threadId ?? await resolveThreadId(db, {
			mailboxId: input.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
		}),
		inReplyTo: parsed.inReplyTo,
		references: parsed.references.length ? parsed.references.join(" ") : null,
		createdAt,
	});

	try {
		await env.BUCKET.put(rawR2Key, input.raw, {
			httpMetadata: { contentType: "message/rfc822" },
		});
		await storeMessageAttachments(env, messageId, parsed.attachments, { validate: false });

		if (input.stagingId && !input.keepStaged) await db.update(messages).set({ status: placement.status }).where(eq(messages.id, messageId));
	} catch (error) {
		await deleteMessageWithObjects(env, db, messageId, rawR2Key);
		throw error;
	}

	// Contact enrichment must never discard successfully stored mail.
	try {
		const contactAddress = direction === "outbound" ? toAddr : fromAddr;
		await upsertContactFromAddress(env, {
			userId: input.userId,
			address: contactAddress,
			source: direction === "outbound" ? "outbound" : "inbound",
		});
	} catch {
		console.warn("Imported message saved; contact update failed", { messageId });
	}

	return { id: messageId, created: true };
}
