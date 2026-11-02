import { and, eq, exists, isNotNull, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs } from "@/db/schema";

/** Matches outbound messages whose send job is still waiting for its scheduled time. */
export function scheduledMessageCondition(db: ReturnType<typeof getDb>): SQL {
	return and(
		eq(messages.direction, "outbound"),
		inArray(messages.status, ["queued", "failed"]),
		exists(
			db
				.select({ id: outboundJobs.id })
				.from(outboundJobs)
				.where(and(eq(outboundJobs.messageId, messages.id), inArray(outboundJobs.status, ["queued", "sending", "failed", "unknown"]), isNotNull(outboundJobs.scheduledAt))),
		),
	)!;
}

/** When a queued outbound message is scheduled to go out; null when it is not scheduled. */
export async function getScheduledTime(db: ReturnType<typeof getDb>, messageId: string): Promise<Date | null> {
	const [job] = await db
		.select({ scheduledAt: outboundJobs.scheduledAt })
		.from(outboundJobs)
		.where(and(eq(outboundJobs.messageId, messageId), inArray(outboundJobs.status, ["queued", "failed"]), isNotNull(outboundJobs.scheduledAt)))
		.limit(1);
	return job?.scheduledAt ?? null;
}

/** Cancels a scheduled send and returns the message to Drafts. Deletes only a job that is
 * still waiting: the queue consumer claims it (queued -> sending) before delivering, so a
 * send already under way is left alone. Returns false when there was nothing to cancel. */
export async function cancelScheduledSend(db: ReturnType<typeof getDb>, messageId: string): Promise<boolean> {
	const waiting = and(eq(outboundJobs.messageId, messageId), inArray(outboundJobs.status, ["queued", "failed"]), isNotNull(outboundJobs.scheduledAt));
	// D1 batch is transactional: returning to Drafts and removing the queued job
	// either both commit or both roll back. Delivery's conditional claim competes
	// with this transaction, never with an intermediate state.
	const [, deleted] = await db.batch([
		db.update(messages).set({ status: "draft" }).where(and(eq(messages.id, messageId), inArray(messages.status, ["queued", "failed"]),
			exists(db.select({ id: outboundJobs.id }).from(outboundJobs).where(waiting)))),
		db.delete(outboundJobs).where(waiting).returning({ id: outboundJobs.id }),
	]);
	return deleted.length > 0;
}


/** Only safe, fixed error categories cross the API boundary. */
export function publicDeliveryError(error: string | null): string | null {
	if (!error) return null;
	if (error.startsWith('{"accepted":')) return "delivery_accepted_unrecorded";
	if (error.startsWith("attachment_retry:")) return "attachment_unavailable";
	return ["queue_pending", "delivery_unknown", "preparation_failed", "attachment_missing", "attachment_unavailable"].includes(error) ? error : null;
}

export async function getScheduledDeliveryState(db: ReturnType<typeof getDb>, messageId: string) {
	const [job] = await db.select({ scheduledAt: outboundJobs.scheduledAt, status: outboundJobs.status, error: outboundJobs.error })
		.from(outboundJobs).where(and(eq(outboundJobs.messageId, messageId), inArray(outboundJobs.status, ["queued", "sending", "failed", "unknown"]), isNotNull(outboundJobs.scheduledAt))).limit(1);
	return job ? { scheduledAt: job.scheduledAt!.toISOString(), deliveryStatus: job.status, deliveryError: publicDeliveryError(job.error) } : {};
}
