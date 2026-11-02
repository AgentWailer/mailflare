import { and, eq, ne, lte, or, like, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, messageAttachments, messages, outboundJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { getEmailAddressList, joinEmailAddressList, splitEmailAddressList } from "@/lib/email/address";
import { formatMessageIdHeader, normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { cleanupUnpublishedAttachments, loadMessageAttachmentContents, storeMessageAttachments, validateAttachments } from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import { prepareCloudflareAttachments } from "@/lib/email/cloud-attachment-utils";
import { DeliveryOutcomeError } from "@/lib/email/send-errors";

export type SendEmailInput = {
	userId: string;
	from: string;
	/** One header-style list or an array; each entry may carry a display name. */
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	/** Message-ID of the message being replied to, with or without angle brackets. */
	inReplyTo?: string | null;
	/** References chain, as a header string or a list of Message-IDs. */
	references?: string | string[] | null;
	/** Conversation to file the sent copy under; defaults to its own Message-ID. */
	threadId?: string | null;
	mailboxId: string;
	attachments?: AttachmentContent[];
	/** Future delivery time. Values at or before the current time send immediately. */
	scheduledAt?: string | Date;
	publicOrigin?: string;
};

const MAX_RECIPIENTS = 50;
const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;
const RECOVERY_DELAY_MS = 5 * 60 * 1000;
const UNCERTAIN_AFTER_MS = 15 * 60 * 1000;
const RECOVERY_BATCH_SIZE = 20;

type PreparedDelivery = {
	input: SendEmailInput;
	messageId: string;
	jobId: string;
	from: string;
	mailboxId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	headers: Record<string, string>;
	attachments: AttachmentContent[];
};

function toRecipientList(value: string | string[] | undefined): string[] {
	const entries = Array.isArray(value) ? value : splitEmailAddressList(value);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of entries) {
		const [address] = getEmailAddressList(entry);
		if (!address || seen.has(address)) continue;
		seen.add(address);
		result.push(entry.trim());
	}
	return result;
}

export async function sendEmail(
	env: CloudflareEnv,
	input: SendEmailInput,
): Promise<{ messageId: string; scheduled?: boolean }> {
	const db = getDb(env);
	const sender = await getAuthorizedSenderAddress(env, input);
	const attachments = input.attachments ?? [];
	validateAttachments(attachments);
	const maxAttachmentMb = await getOutboundAttachmentMaxMb(env);
	const maxAttachmentBytes = maxAttachmentMb * 1_000_000;
	if (attachments.some((attachment) => attachment.content.byteLength > maxAttachmentBytes) ||
		attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0) > maxAttachmentBytes) {
		throw new Error(`Attachments exceed the administrator's ${maxAttachmentMb} MB outgoing limit`);
	}
	if (input.subject.length > 998) throw new Error("Subject exceeds Cloudflare's 998-character limit");

	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	if (to.length === 0) throw new Error("At least one recipient is required");
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
		throw new Error(`A message can have at most ${MAX_RECIPIENTS} recipients`);
	}
	for (const address of [...to, ...cc, ...bcc]) {
		await upsertContactFromAddress(env, { userId: input.userId, address, source: "outbound" });
	}

	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	if (new TextEncoder().encode(Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")).byteLength > 16 * 1024) {
		throw new Error("Headers exceed Cloudflare's 16 KB limit");
	}

	const messageId = newId("msg");
	const requestedSchedule = input.scheduledAt ? new Date(input.scheduledAt) : null;
	const scheduledAt = requestedSchedule && requestedSchedule.getTime() > Date.now()
		? requestedSchedule
		: null;
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);
	const toAddr = joinEmailAddressList(to);

	// Store bytes first, then publish the message, membership and durable outbox
	// together. A failed publication must not leave queued mail with no job.
	const stored = await storeMessageAttachments(env, messageId, attachments, { persist: false });
	stored.forEach((attachment, index) => { attachments[index].storageId = attachment.id; });
	const jobId = newId("job");
	try {
		await db.batch([
			db.insert(messages).values({
				id: messageId,
				userId: input.userId,
				mailboxId: sender.mailboxId,
				direction: "outbound",
				fromAddr: sender.fromAddr,
				toAddr,
				ccAddr: cc.length ? joinEmailAddressList(cc) : null,
				bccAddr: bcc.length ? joinEmailAddressList(bcc) : null,
				subject: input.subject,
				snippet,
				textBody: input.text ?? null,
				htmlBody: input.html ?? null,
				status: "queued",
				threadId: input.threadId ?? null,
				inReplyTo,
				references: references.length ? references.join(" ") : null,
			}),
			...stored.map(file => db.insert(messageAttachments).values({ id: file.id, messageId, filename: file.filename,
				contentType: file.type, size: file.size, disposition: file.disposition, contentId: file.contentId, r2Key: file.r2Key })),
			db.insert(outboundJobs).values({
				id: jobId,
				userId: input.userId,
				messageId,
				// An interrupted immediate send is uncertain, never an automatic retry.
				status: scheduledAt ? "queued" : "sending",
				payload: JSON.stringify({
					...input,
					from: sender.fromAddr,
					to,
					cc,
					bcc,
					mailboxId: sender.mailboxId,
					attachments: attachments.map(({ storageId, filename, type, disposition, contentId }) => ({ storageId, filename, type, disposition, contentId })),
				}),
				scheduledAt,
			}),
		]);
	} catch (error) {
		// D1 may commit a batch whose response is lost. Confirm our unique job
		// before cleaning staged objects or telling the caller to repeat the send.
		let published: boolean;
		try {
			const [job] = await db.select({ id: outboundJobs.id }).from(outboundJobs).where(eq(outboundJobs.id, jobId)).limit(1);
			published = !!job;
		} catch {
			throw new DeliveryOutcomeError("delivery_unknown", "Delivery preparation could not be confirmed. Check Sent and Scheduled before sending again.");
		}
		if (!published) { await cleanupUnpublishedAttachments(env, stored); throw error; }
	}

	const delivery: PreparedDelivery = {
		input: { ...input, attachments: undefined },
		messageId,
		jobId,
		from: sender.fromAddr,
		mailboxId: sender.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments,
	};
	if (scheduledAt) {
		// The durable job is the outbox. A lost queue handoff is recovered by cron.
		try { await enqueueScheduledDelivery(env, delivery, scheduledAt); }
		catch {
			// The outbox is already committed even if this diagnostic update also fails.
			await db.update(outboundJobs).set({ error: "queue_pending" }).where(eq(outboundJobs.id, jobId))
				.catch(() => console.error("Outbound queue handoff awaits recovery"));
		}
		return { messageId, scheduled: true };
	}

	await deliverEmail(env, delivery);
	return { messageId };
}

/** Provider acceptance is a separate boundary from storage and post-send work. */
async function deliverEmail(env: CloudflareEnv, delivery: PreparedDelivery): Promise<void> {
	const { input, messageId, jobId, from, to, cc, bcc, headers, attachments } = delivery;
	const db = getDb(env);
	let providerStarted = false;
	let acceptedId: string | null = null;
	try {
		await db.update(outboundJobs).set({ status: "sending", updatedAt: new Date(), error: null }).where(eq(outboundJobs.id, jobId));
		await getAuthorizedSenderAddress(env, { userId: input.userId, mailboxId: delivery.mailboxId, from });
		const provider = await getOutboundProviderConfig(env, from);
		const prepared = provider.provider === "cloudflare"
			? await prepareCloudflareAttachments(env, attachments, { subject: input.subject, html: input.html, text: input.text, headers, publicOrigin: input.publicOrigin })
			: { attachments, html: input.html, text: input.text };
		if (prepared.text !== input.text || prepared.html !== input.html) {
			await db.update(messages).set({ textBody: prepared.text ?? null, htmlBody: prepared.html ?? null }).where(eq(messages.id, messageId));
		}
		providerStarted = true;
		const response = await sendThroughProvider(env, provider, {
			from, to, cc, bcc, subject: input.subject, headers, html: prepared.html, text: prepared.text,
			attachments: prepared.attachments.map(attachment => ({ filename: attachment.filename, type: attachment.type, content: attachment.content,
				disposition: attachment.disposition === "inline" && attachment.contentId ? "inline" : "attachment", contentId: attachment.contentId })),
		}, jobId);
		acceptedId = response.messageId;
		await persistAcceptedDelivery(env, delivery, acceptedId);
	} catch (error) {
		// A lost D1 response is not a failed commit. Preserve an already persisted
		// provider receipt, including when the follow-up read is also interrupted.
		let alreadySent = false;
		if (acceptedId) {
			try {
				const [job] = await db.select({ status: outboundJobs.status }).from(outboundJobs).where(eq(outboundJobs.id, jobId)).limit(1);
				alreadySent = job?.status === "sent";
			} catch { /* The conditional updates below cannot downgrade a committed send. */ }
		}
		// Once a provider request begins, a timeout/disconnect cannot prove non-delivery.
		// Never make this job eligible for automatic delivery again.
		const code = acceptedId ? JSON.stringify({ accepted: acceptedId }) : providerStarted ? "delivery_unknown" : "preparation_failed";
		if (!alreadySent) {
			try {
				await db.batch([
					db.update(outboundJobs).set({ status: providerStarted ? "unknown" : "failed", error: code, updatedAt: new Date() }).where(and(eq(outboundJobs.id, jobId), ne(outboundJobs.status, "sent"))),
					db.update(messages).set({ status: providerStarted ? "queued" : "failed" }).where(and(eq(messages.id, messageId), ne(messages.status, "sent"))),
				]);
			} catch { console.error("Outbound status persistence needs recovery"); }
			if (providerStarted) throw new DeliveryOutcomeError(acceptedId ? "delivery_status_pending" : "delivery_unknown", acceptedId
				? "Delivery was accepted, but its status could not be saved. Check Sent before sending again."
				: "Delivery outcome is unknown. Check Sent and the recipient before sending again.");
			throw error;
		}
	}
	// Post-send failures must never convert a provider-confirmed delivery to failed.
	await finishSendBookkeeping(env, delivery, acceptedId!);
}

async function persistAcceptedDelivery(env: CloudflareEnv, delivery: PreparedDelivery, providerMessageId: string) {
	const db = getDb(env);
	await db.batch([
		db.update(messages).set({ status: "sent", providerMessageId,
			threadId: delivery.input.threadId ?? normalizeMessageId(providerMessageId) ?? delivery.messageId }).where(eq(messages.id, delivery.messageId)),
		db.update(outboundJobs).set({ status: "sent", error: "post_send_pending:audit,webhook", updatedAt: new Date() }).where(eq(outboundJobs.id, delivery.jobId)),
	]);
}

async function finishSendBookkeeping(env: CloudflareEnv, delivery: PreparedDelivery, providerMessageId: string, pending = ["audit", "webhook"]) {
	const db = getDb(env), failed: string[] = [];
	if (pending.includes("audit")) {
		try {
			// A previous insert may have committed before its response was interrupted.
			const [existing] = await db.select({ id: auditLogs.id }).from(auditLogs)
				.where(and(eq(auditLogs.messageId, delivery.messageId), eq(auditLogs.action, "email.send"))).limit(1);
			if (!existing) await createAuditLog(env, { actorUserId: delivery.input.userId, mailboxId: delivery.mailboxId,
				messageId: delivery.messageId, action: "email.send", metadata: { to: joinEmailAddressList(delivery.to), cc: delivery.cc.length ? joinEmailAddressList(delivery.cc) : undefined, subject: delivery.input.subject } });
		} catch { failed.push("audit"); }
	}
	if (pending.includes("webhook")) {
		try { await dispatchWebhooks(env, delivery.input.userId, "message.outbound", { messageId: delivery.messageId, providerMessageId,
			to: joinEmailAddressList(delivery.to), cc: delivery.cc.length ? joinEmailAddressList(delivery.cc) : undefined }); }
		catch { failed.push("webhook"); }
	}
	try { await db.update(outboundJobs).set({ error: failed.length ? `post_send_pending:${failed.join(",")}` : null, updatedAt: new Date() })
		.where(and(eq(outboundJobs.id, delivery.jobId), eq(outboundJobs.status, "sent"))); }
	catch { console.error("Outbound bookkeeping remains pending"); }
}

export type OutboundQueueMessage = {
	kind: "email.scheduled";
	jobId: string;
	messageId: string;
	scheduledAt: string;
};

async function enqueueScheduledDelivery(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
	scheduledAt: Date,
): Promise<void> {
	const delaySeconds = Math.min(
		MAX_QUEUE_DELAY_SECONDS,
		Math.max(1, Math.ceil((scheduledAt.getTime() - Date.now()) / 1000)),
	);
	await env.OUTBOUND_QUEUE.send(
		{
			kind: "email.scheduled",
			jobId: delivery.jobId,
			messageId: delivery.messageId,
			scheduledAt: scheduledAt.toISOString(),
		},
		{ delaySeconds },
	);
	await getDb(env).update(outboundJobs).set({ updatedAt: new Date(), error: null }).where(and(eq(outboundJobs.id, delivery.jobId), eq(outboundJobs.status, "queued")));
}

export async function processOutboundQueue(
	env: CloudflareEnv,
	payload: OutboundQueueMessage,
): Promise<void> {
	const db = getDb(env);
	const [job] = await db
		.select()
		.from(outboundJobs)
		.where(eq(outboundJobs.id, payload.jobId))
		.limit(1);
	if (!job || job.status !== "queued") return;
	if (job.messageId !== payload.messageId || !job.scheduledAt) return;
	const scheduledAt = job.scheduledAt;
	const input = JSON.parse(job.payload) as SendEmailInput;
	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	const delivery: PreparedDelivery = {
		input,
		messageId: payload.messageId,
		jobId: payload.jobId,
		from: input.from,
		mailboxId: input.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments: [],
	};
	if (scheduledAt.getTime() > Date.now()) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		return;
	}
	// Attachment loading can fail safely before the claim; no provider call has begun.
	try { delivery.attachments = await loadMessageAttachmentContents(env, payload.messageId); }
	catch (error) {
		const previous = Number(job.error?.match(/^attachment_retry:(\d+)$/)?.[1] ?? 0);
		const permanent = error instanceof Error && error.name === "MissingAttachmentError";
		const exhausted = permanent || previous >= 2;
		await db.update(outboundJobs).set({ status: exhausted ? "failed" : "queued", error: permanent ? "attachment_missing" : exhausted ? "attachment_unavailable" : `attachment_retry:${previous + 1}`, updatedAt: new Date() })
			.where(and(eq(outboundJobs.id, job.id), eq(outboundJobs.status, "queued")));
		throw error;
	}
	// Claim the job before delivering. Cancelling deletes only a job that is still
	// "queued", so exactly one of cancel and delivery wins.
	const claimed = await db
		.update(outboundJobs)
		.set({ status: "sending", updatedAt: new Date() })
		.where(and(eq(outboundJobs.id, payload.jobId), eq(outboundJobs.status, "queued")))
		.returning({ id: outboundJobs.id });
	if (!claimed.length) return;
	await deliverEmail(env, delivery);
}


/** Bounded outbox recovery. Sending/unknown jobs are never re-delivered. */
export async function recoverOutboundJobs(env: CloudflareEnv, now = new Date()): Promise<void> {
	const db = getDb(env), stale = new Date(now.getTime() - RECOVERY_DELAY_MS);
	// A hard interruption after claim is an uncertain delivery, not a retryable send.
	const stuck = await db.select({ id: outboundJobs.id }).from(outboundJobs)
		.where(and(eq(outboundJobs.status, "sending"), lte(outboundJobs.updatedAt, new Date(now.getTime() - UNCERTAIN_AFTER_MS))))
		.limit(RECOVERY_BATCH_SIZE);
	for (const job of stuck) await db.update(outboundJobs).set({ status: "unknown", error: "delivery_unknown", updatedAt: now })
		.where(and(eq(outboundJobs.id, job.id), eq(outboundJobs.status, "sending"), lte(outboundJobs.updatedAt, new Date(now.getTime() - UNCERTAIN_AFTER_MS))));
	const jobs = await db.select({ id: outboundJobs.id, messageId: outboundJobs.messageId, userId: outboundJobs.userId, status: outboundJobs.status, error: outboundJobs.error, scheduledAt: outboundJobs.scheduledAt, updatedAt: outboundJobs.updatedAt })
		.from(outboundJobs).where(and(lte(outboundJobs.updatedAt, stale), or(
			and(eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt), lte(outboundJobs.scheduledAt, now)),
			and(eq(outboundJobs.status, "sent"), like(outboundJobs.error, "post_send_pending:%")),
			and(eq(outboundJobs.status, "unknown"), like(outboundJobs.error, '{"accepted":%')),
		)))
		.orderBy(outboundJobs.updatedAt).limit(RECOVERY_BATCH_SIZE);
	for (const job of jobs) {
		if (!job.messageId) continue;
		const retryQueue = job.status === "queued" && job.scheduledAt && job.scheduledAt <= now;
		const retryBookkeeping = job.status === "sent" && job.error?.startsWith("post_send_pending:");
		let receipt: string | null = null;
		if (job.status === "unknown" && job.error?.startsWith('{"accepted":')) {
			try { const parsed = JSON.parse(job.error); if (typeof parsed.accepted === "string" && parsed.accepted.length < 1024) receipt = parsed.accepted; } catch { /* Not a known receipt. */ }
		}
		if (!retryQueue && !retryBookkeeping && !receipt) continue;
		const claimed = await db.update(outboundJobs).set({ updatedAt: now }).where(and(eq(outboundJobs.id, job.id), eq(outboundJobs.status, job.status), eq(outboundJobs.updatedAt, job.updatedAt))).returning({ id: outboundJobs.id });
		if (!claimed.length) continue;
		try {
			if (retryQueue) {
				await env.OUTBOUND_QUEUE.send({ kind: "email.scheduled", jobId: job.id, messageId: job.messageId, scheduledAt: job.scheduledAt!.toISOString() } satisfies OutboundQueueMessage);
				continue;
			}
			// Recovery never loads bodies or attachment bytes and never calls the provider.
			const [message] = await db.select({ providerMessageId: messages.providerMessageId, mailboxId: messages.mailboxId, from: messages.fromAddr,
				to: messages.toAddr, cc: messages.ccAddr, bcc: messages.bccAddr, subject: messages.subject, threadId: messages.threadId }).from(messages).where(eq(messages.id, job.messageId)).limit(1);
			if (!message?.mailboxId) continue;
			const input: SendEmailInput = { userId: job.userId, mailboxId: message.mailboxId, from: message.from, to: message.to, cc: message.cc ?? undefined,
				bcc: message.bcc ?? undefined, subject: message.subject ?? "", threadId: message.threadId };
			const delivery: PreparedDelivery = { input, messageId: job.messageId, jobId: job.id, from: input.from, mailboxId: input.mailboxId,
				to: toRecipientList(input.to), cc: toRecipientList(input.cc), bcc: toRecipientList(input.bcc), headers: {}, attachments: [] };
			if (receipt) { await persistAcceptedDelivery(env, delivery, receipt); await finishSendBookkeeping(env, delivery, receipt); }
			else if (message.providerMessageId) await finishSendBookkeeping(env, delivery, message.providerMessageId, job.error!.slice("post_send_pending:".length).split(","));
		} catch { console.error("Outbound recovery deferred"); }
	}
}
