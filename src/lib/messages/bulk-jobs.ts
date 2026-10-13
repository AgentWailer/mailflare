import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { bulkScopeSchema, executeBulkScope, type BulkScopeInput, type ScopeChunk } from "./bulk-scope";

export type BulkJob = {
 id: string; user_id: string; request_id: string; payload: string; scope: string;
 status: "pending" | "running" | "waiting" | "failed" | "completed" | "paused";
 processed: number; total: number; after_row: number; pending_chunk: string | null;
 lease_token: string | null; lease_until: number; retry_at: number; consecutive_failures: number;
 error: string | null; dismissed: number; created_at: number; updated_at: number;
};
const LEASE_MS = 180000;
export function publicBulkJob(job: BulkJob) {
 const payload = bulkScopeSchema.parse(JSON.parse(job.payload));
 return { id: job.id, requestId: job.request_id, canRetry: job.status !== "paused", scope: JSON.parse(job.scope), action: payload.action, destinationFolderId: payload.destinationFolderId, organization: payload.organization,
  status: job.status === "completed" ? "done" : job.status === "failed" || job.status === "paused" ? "failed" : "running",
  processed: job.processed, total: job.total, error: job.error, retryAt: job.retry_at };
}
const load = (env: CloudflareEnv, id: string) => env.DB.prepare("SELECT * FROM message_bulk_jobs WHERE id=?").bind(id).first<BulkJob>();
async function enqueue(env: CloudflareEnv, id: string, delaySeconds = 0) { if (env.AGENT_QUEUE) await env.AGENT_QUEUE.send({ kind: "messages.bulk", jobId: id }, { delaySeconds }); }
export async function latestBulkJob(env: CloudflareEnv, userId: string) {
 const job = await env.DB.prepare("SELECT * FROM message_bulk_jobs WHERE user_id=? ORDER BY CASE WHEN status IN ('pending','running','waiting') THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1").bind(userId).first<BulkJob>();
 return job && !job.dismissed ? publicBulkJob(job) : null;
}
export async function createBulkJob(env: CloudflareEnv, user: SessionUser, input: BulkScopeInput, scope: unknown, requestId: string) {
 if (input.action === "select") throw new Error("Select is not a background action");
 const existing = await env.DB.prepare("SELECT * FROM message_bulk_jobs WHERE user_id=? AND request_id=?").bind(user.id, requestId).first<BulkJob>();
 if (existing) { await enqueue(env, existing.id); return publicBulkJob(existing); }
 if (!env.AGENT_QUEUE) throw new Error("Background queue is not configured");
 // Old selections/jobs were captured before categorized mail joined the inbox.
 // Preserve their narrower scope rather than expanding an in-flight archive/delete.
 const capturedInput = { ...input, inboxPolicy: input.inboxPolicy ?? "primary_only" as const };
 const preview = await executeBulkScope(env, user, { ...capturedInput, after: 0 }, { preview: true });
 if (!preview.ok) return preview;
 const selected = await preview.json() as { snapshot: number; actorId: string; mailboxIds: string[]; total: number };
 const id = newId("bulkjob"), now = Date.now();
 const payload = { ...capturedInput, snapshot: selected.snapshot, actorId: user.id, mailboxIds: selected.mailboxIds, after: 0 };
 try {
  await env.DB.prepare("INSERT INTO message_bulk_jobs(id,user_id,request_id,payload,scope,total,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
   .bind(id, user.id, requestId, JSON.stringify(payload), JSON.stringify(scope), selected.total, now, now).run();
 } catch (error) {
  const duplicate = await env.DB.prepare("SELECT * FROM message_bulk_jobs WHERE user_id=? AND request_id=?").bind(user.id, requestId).first<BulkJob>();
  if (duplicate) return publicBulkJob(duplicate);
  const active = await env.DB.prepare("SELECT id FROM message_bulk_jobs WHERE user_id=? AND status IN ('pending','running','waiting')").bind(user.id).first();
  if (active) return new Response(JSON.stringify({ error: "Another background action is running" }), { status: 409, headers: { "Content-Type": "application/json" } });
  throw error;
 }
 // The durable record is the outbox: cron will enqueue it even if this send fails.
 await enqueue(env, id).catch(() => {});
 return publicBulkJob((await load(env, id))!);
}
export async function controlBulkJob(env: CloudflareEnv, userId: string, id: string, action: "retry" | "dismiss") {
 const job = await load(env, id);if (!job || job.user_id !== userId) return null;
 if (action === "dismiss") {
  await env.DB.prepare("UPDATE message_bulk_jobs SET dismissed=1 WHERE id=? AND user_id=? AND status IN ('failed','completed','paused')").bind(id, userId).run();
 } else if (job.status === "failed") {
  await env.DB.prepare("UPDATE message_bulk_jobs SET status='pending',retry_at=0,error=NULL,consecutive_failures=0,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND user_id=? AND status IN ('failed','paused') AND NOT EXISTS(SELECT 1 FROM message_bulk_jobs WHERE user_id=? AND status IN ('pending','running','waiting'))").bind(Date.now(), id, userId, userId).run();
  await enqueue(env, id).catch(() => {});
 }
 return publicBulkJob((await load(env, id))!);
}

/** Small invocations, leased checkpoints and saved pending chunks tolerate redelivery/crashes. */
export async function processBulkJob(env: CloudflareEnv, id: string) {
 const now = Date.now(), lease = newId("bulklease");
 const job = await env.DB.prepare("UPDATE message_bulk_jobs SET status='running',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status IN ('pending','running','waiting') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) RETURNING *")
  .bind(lease, now + LEASE_MS, now, id, now, now).first<BulkJob>();
 if (!job) return;
 let permanentError = false;
 try {
  const savedInput = bulkScopeSchema.parse(JSON.parse(job.payload));
  const input = { ...savedInput, inboxPolicy: savedInput.inboxPolicy ?? "primary_only" as const };
  for (let step = 0; step < 12 && Date.now() - now < 20000; step++) {
   const [user] = await getDb(env).select().from(users).where(eq(users.id, job.user_id)).limit(1);
   if (!user || user.disabled) { permanentError = true;throw new Error("Account is no longer authorized"); }
   const response = await executeBulkScope(env, user, { ...input, after: job.after_row }, {
    pending: job.pending_chunk ? JSON.parse(job.pending_chunk) as ScopeChunk : undefined,
    beforeApply: async chunk => {
     const held = await env.DB.prepare("UPDATE message_bulk_jobs SET pending_chunk=?,lease_until=?,updated_at=? WHERE id=? AND lease_token=? RETURNING id")
      .bind(JSON.stringify(chunk), Date.now() + LEASE_MS, Date.now(), id, lease).first();
     if (!held) throw new Error("Background job lease changed");
    },
   });
   if (!response.ok) { permanentError = response.status >= 400 && response.status < 500 && ![408,429].includes(response.status);throw new Error((await response.json() as { error?: string }).error ?? "Background action failed"); }
   const chunk = await response.json() as ScopeChunk;
   const checkpoint = await env.DB.prepare("UPDATE message_bulk_jobs SET after_row=?,processed=processed+?,pending_chunk=NULL,error=NULL,consecutive_failures=0,status=?,lease_until=?,updated_at=? WHERE id=? AND lease_token=? RETURNING *")
    .bind(chunk.after, chunk.messageIds.length, chunk.done ? "completed" : "running", Date.now() + LEASE_MS, Date.now(), id, lease).first<BulkJob>();
   if (!checkpoint) return;
   Object.assign(job, checkpoint);
   if (chunk.done) break;
  }
  await env.DB.prepare("UPDATE message_bulk_jobs SET status=CASE WHEN status='running' THEN 'pending' ELSE status END,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?").bind(Date.now(), id, lease).run();
 } catch (error) {
  const failures = job.consecutive_failures + 1, failed = permanentError || failures >= 8;
  await env.DB.prepare("UPDATE message_bulk_jobs SET status=?,error=?,consecutive_failures=?,retry_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?")
   .bind(failed ? "failed" : "waiting", (error instanceof Error ? error.message : "Background action failed").slice(0,350), failures, failed ? 0 : Date.now() + Math.min(900000, 10000 * 2 ** (failures - 1)), Date.now(), id, lease).run();
 }
 const saved = await load(env, id);
 if (saved && ["pending", "waiting"].includes(saved.status)) await enqueue(env, id, Math.max(0, Math.ceil((saved.retry_at - Date.now()) / 1000))).catch(() => {});
}
export async function recoverBulkJobs(env: CloudflareEnv) {
 if (!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_bulk_jobs'").first()) return;
 const due = await env.DB.prepare("SELECT id FROM message_bulk_jobs WHERE status IN ('pending','running','waiting') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) ORDER BY updated_at LIMIT 5").bind(Date.now(), Date.now()).all<{id:string}>();
 await Promise.allSettled(due.results.map(job => enqueue(env, job.id)));
}
