import { newId } from "@/lib/ids";
import { safeErrorCategory } from "@/lib/security/logging";
import type { QueueFailureKind, QueueFailureStatus } from "./failures-types";

// Keep in step with every consumer's max_retries in wrangler.jsonc; covered by a regression test.
export const QUEUE_MAX_RETRIES = 3;
const REPORT_PREFIX = "queue_failure_";
const REPORT_ACTION = "queue.processing_failed";
const REPORT_LIMIT = 100;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const kinds: Record<string, QueueFailureKind> = {
	"database.backup": "backup",
	"gmail.sent-sync": "gmail",
	"import.mbox": "import",
	"import.sort": "sort",
	"paperless.document": "paperless",
	"mail.content-audit": "audit",
	"messages.bulk": "bulk",
	"agent.draft": "agent",
	"webhook.retry": "webhook",
	"email.scheduled": "outbound",
};
const knownKinds = new Set<QueueFailureKind>(["inbound", "unknown", ...Object.values(kinds)]);
const categories = new Set(["TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "Error"]);

function queueKind(body: unknown): QueueFailureKind {
	if (!body || typeof body !== "object") return "unknown";
	if ("rawR2Key" in body && "from" in body && "to" in body) return "inbound";
	const kind = "kind" in body ? body.kind : undefined;
	return typeof kind === "string" && Object.hasOwn(kinds, kind) ? kinds[kind] : "unknown";
}

function reportBoundary(timestamp: number): string {
	return `${REPORT_PREFIX}${String(Math.floor(timestamp)).padStart(13, "0")}_`;
}

/** Best-effort final-attempt notice; must never prevent the queue's existing retry/DLQ handling. */
export async function recordFinalQueueFailure(
	env: Pick<CloudflareEnv, "DB">,
	body: unknown,
	attempts: number,
	error: unknown,
	now = Date.now(),
): Promise<void> {
	// attempts includes the original delivery, followed by max_retries retries.
	if (!Number.isSafeInteger(attempts) || attempts <= QUEUE_MAX_RETRIES) return;
	try {
		await env.DB.prepare(`INSERT INTO audit_logs (id, action, metadata, created_at) VALUES (?, ?, ?, ?)`).bind(
			`${reportBoundary(now)}${newId()}`,
			REPORT_ACTION,
			JSON.stringify({ kind: queueKind(body), category: safeErrorCategory(error), attempts }),
			Math.floor(now / 1000),
		).run();
	} catch (failure) {
		console.error("Queue failure notice could not be saved", { error: safeErrorCategory(failure) });
	}
}

/** Timestamp-prefixed primary keys bound both work and response size without a new index/table. */
export async function getQueueFailureStatus(env: Pick<CloudflareEnv, "DB">, now = Date.now()): Promise<QueueFailureStatus> {
	const since = now - WINDOW_MS;
	const result = await env.DB.prepare(`SELECT metadata, created_at FROM audit_logs
		WHERE id >= ? AND id < ? AND action = ? ORDER BY id DESC LIMIT ?`).bind(
		reportBoundary(since), reportBoundary(now + 1), REPORT_ACTION, REPORT_LIMIT + 1,
	).all<{ metadata: string; created_at: number }>();
	return {
		count: Math.min(result.results.length, REPORT_LIMIT),
		hasMore: result.results.length > REPORT_LIMIT,
		since: new Date(since).toISOString(),
		recent: result.results.slice(0, 5).map(row => {
			let value: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(row.metadata);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
			} catch { /* Old or malformed diagnostic rows must not break the status card. */ }
			return {
				kind: knownKinds.has(value.kind as QueueFailureKind) ? value.kind as QueueFailureKind : "unknown",
				category: typeof value.category === "string" && categories.has(value.category) ? value.category : "Error",
				attempts: typeof value.attempts === "number" && Number.isSafeInteger(value.attempts) && value.attempts > 0 ? value.attempts : 0,
				createdAt: new Date(row.created_at * 1000).toISOString(),
			};
		}),
	};
}
