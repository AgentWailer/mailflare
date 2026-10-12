import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxSortingSettings, users } from "@/db/schema";
import { assertAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { classifyIncomingMail, DEFAULT_SORTING_SETTINGS } from "@/lib/mail-sorting/classifier";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { newId } from "@/lib/ids";
import type { MboxJob } from "./mbox-jobs";

export type MboxSortingJob = {
 import_job_id: string; user_id: string; mailbox_id: string;
 status: "pending" | "running" | "waiting" | "paused" | "failed" | "completed";
 processed: number; primary_count: number; promotions_count: number; social_count: number; invoices_count: number; orders_count: number;
 error: string | null; wait_reason: "import" | "daily_limit" | "retry" | "sorting_disabled" | null; retry_at: number; consecutive_failures: number;
 lease_token: string | null; lease_until: number; created_at: number; updated_at: number;
};
type Candidate = { id: string; user_id: string; from_addr: string; to_addr: string; subject: string | null;
 text_body: string | null; html_body: string | null; raw_r2_key: string | null; in_reply_to: string | null; spam_score: number | null };
const LEASE_MS = 5 * 60_000;
// The partial index covers status/category placement; decision versions exclude already processed/manual mail.
const ELIGIBLE = "direction='inbound' AND status IN ('received','archived') AND category='primary' AND folder_id IS NULL AND snoozed_until IS NULL AND (sorting_decision IS NULL OR CASE WHEN json_valid(sorting_decision) THEN json_extract(sorting_decision,'$.source') IN ('rule','clef','fallback') AND coalesce(json_extract(sorting_decision,'$.policyVersion'),0)<4 ELSE 0 END)";
const load = (env: CloudflareEnv, id: string) => env.DB.prepare("SELECT * FROM mbox_sorting_jobs WHERE import_job_id=?").bind(id).first<MboxSortingJob>();
const parent = (env: CloudflareEnv, id: string) => env.DB.prepare("SELECT * FROM mbox_import_jobs WHERE id=?").bind(id).first<MboxJob>();
const bounds = (id: string) => [`msg_mbox_${id}_`, `msg_mbox_${id}\``] as const;
async function enqueue(env: CloudflareEnv, id: string) {
 if (!env.AGENT_QUEUE) throw new Error("The background queue is not configured");
 await env.AGENT_QUEUE.send({ kind: "import.sort", jobId: id });
}
export function publicMboxSortingJob(job: MboxSortingJob) {
 return { status: job.status, processed: job.processed, primary: job.primary_count, promotions: job.promotions_count,
  social: job.social_count, invoices: job.invoices_count ?? 0, orders: job.orders_count ?? 0, error: job.error, waitReason: job.wait_reason, retryAt: job.retry_at };
}
export async function getMboxSortingJobs(env: CloudflareEnv, mailboxId: string) {
 if (!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mbox_sorting_jobs'").first()) return new Map<string, ReturnType<typeof publicMboxSortingJob>>();
 const rows = await env.DB.prepare("SELECT * FROM mbox_sorting_jobs WHERE mailbox_id=?").bind(mailboxId).all<MboxSortingJob>();
 return new Map(rows.results.map(job => [job.import_job_id, publicMboxSortingJob(job)]));
}
export async function controlMboxSortingJob(env: CloudflareEnv, user: SessionUser, id: string, action: "start" | "pause" | "resume") {
 assertAdmin(user);
 const source = await parent(env, id);
 if (!source) throw new Error("Import job not found");
 const access = await getMailboxAccessLevel(getDb(env), user, source.mailbox_id);
 if (source.user_id !== user.id || !access?.canManage) throw new Error("Import permission denied");
 if (!env.AGENT_QUEUE) throw new Error("The background queue is not configured");
 if (action === "start") {
  if (!env.AI) throw new Error("Workers AI is not configured");
  const now = Date.now();
  await env.DB.prepare("INSERT INTO mbox_sorting_jobs(import_job_id,user_id,mailbox_id,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING")
   .bind(id, user.id, source.mailbox_id, now, now).run();
  const job = await load(env, id);
  if (job?.status === "pending") await enqueue(env, id);
 } else if (action === "pause") {
  await env.DB.prepare("UPDATE mbox_sorting_jobs SET status='paused',updated_at=? WHERE import_job_id=? AND status IN ('pending','running','waiting')").bind(Date.now(), id).run();
 } else {
  const job = await load(env, id);
  if (!job) throw new Error("Start archive sorting first");
  if (job.lease_token && job.lease_until > Date.now()) throw new Error("Wait for the current message to finish before resuming");
  await env.DB.prepare("UPDATE mbox_sorting_jobs SET status='pending',lease_token=NULL,lease_until=0,retry_at=0,error=NULL,wait_reason=NULL,consecutive_failures=0,updated_at=? WHERE import_job_id=? AND status<>'completed' AND (lease_token IS NULL OR lease_until<?)")
   .bind(Date.now(), id, Date.now()).run();
  if ((await load(env, id))?.status === "pending") await enqueue(env, id);
 }
 const job = await load(env, id);
 if (!job) throw new Error("Archive sorting job not found");
 return publicMboxSortingJob(job);
}

/** Fetch only mailing-list/thread headers. Historical Authentication-Results are not receiver evidence. */
async function historicalHeaders(env: CloudflareEnv, message: Candidate) {
 if (!message.raw_r2_key) throw new Error("The original message headers are unavailable");
 const object = await env.BUCKET.get(message.raw_r2_key, { range: { offset: 0, length: 64 * 1024 } });
 if (!object || !("body" in object)) throw new Error("The original message object is unavailable");
 const reader = object.body.getReader(), bytes = new Uint8Array(64 * 1024); let length = 0, complete = false;
 try { while (length < bytes.length) {
  const chunk = await reader.read(); if (chunk.done) break;
  const part = chunk.value.subarray(0, bytes.length - length); bytes.set(part, length); length += part.length;
  if (/\r?\n\r?\n/.test(new TextDecoder().decode(bytes.subarray(0, length)))) { complete = true; break; }
 } } finally { await reader.cancel(); reader.releaseLock(); }
 if (!complete) throw new Error("The original message header is incomplete or exceeds 64 KiB");
 const header = new TextDecoder().decode(bytes.subarray(0, length)).split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[\t ]+/g, " ");
 const selected: Record<string, string> = {};
 for (const line of header.split(/\r?\n/)) {
  const match = line.match(/^([^:]+):\s*(.*)$/);
  if (match && ["list-unsubscribe", "list-id", "precedence", "in-reply-to"].includes(match[1].toLowerCase())) selected[match[1].toLowerCase()] = match[2];
 }
 if (message.in_reply_to) selected["in-reply-to"] = message.in_reply_to;
 return selected;
}
async function finish(env: CloudflareEnv, id: string, lease: string, state: MboxSortingJob["status"], reason: MboxSortingJob["wait_reason"] = null, retryAt = 0) {
 await env.DB.prepare("UPDATE mbox_sorting_jobs SET status=CASE WHEN status='paused' THEN 'paused' ELSE ? END,wait_reason=?,retry_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE import_job_id=? AND lease_token=?")
  .bind(state, reason, retryAt, Date.now(), id, lease).run();
}
export async function processMboxSortingJob(env: CloudflareEnv, id: string) {
 const now = Date.now(), lease = newId("sortlease");
 const job = await env.DB.prepare("UPDATE mbox_sorting_jobs SET status='running',lease_token=?,lease_until=?,error=NULL,wait_reason=NULL,updated_at=? WHERE import_job_id=? AND status IN ('pending','waiting','running') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) RETURNING *")
  .bind(lease, now + LEASE_MS, now, id, now, now).first<MboxSortingJob>();
 if (!job) return;
 try {
  const source = await parent(env, id);
  if (!source || source.user_id !== job.user_id || source.mailbox_id !== job.mailbox_id) throw new Error("The original import no longer matches this sorting job");
  const db = getDb(env), [user] = await db.select().from(users).where(eq(users.id, job.user_id)).limit(1);
  if (!user || user.disabled || user.role !== "admin") throw new Error("Import administrator is disabled, deleted or no longer an administrator");
  const access = await getMailboxAccessLevel(db, user, job.mailbox_id);
  if (!access?.canManage) throw new Error("Import permission was revoked");
  const [settings] = await db.select().from(mailboxSortingSettings).where(eq(mailboxSortingSettings.mailboxId, job.mailbox_id)).limit(1);
  const config = settings ?? DEFAULT_SORTING_SETTINGS;
  if (config.mode !== "active") { await finish(env, id, lease, "paused", "sorting_disabled"); return; }
  const budget = Math.floor(config.dailyLimit / 2);
  const [lower, upper] = bounds(id);
  const candidates = (await env.DB.prepare(`SELECT id,user_id,from_addr,to_addr,subject,substr(text_body,1,6000) AS text_body,substr(html_body,1,64000) AS html_body,raw_r2_key,in_reply_to,spam_score FROM messages WHERE mailbox_id=? AND id>=? AND id<? AND ${ELIGIBLE} ORDER BY id LIMIT 5`)
   .bind(job.mailbox_id, lower, upper).all<Candidate>()).results;
  if (!candidates.length) {
   // New messages become eligible as the independent import advances.
   await finish(env, id, lease, source.status === "completed" ? "completed" : "waiting", source.status === "completed" ? null : "import", source.status === "completed" ? 0 : Date.now() + 60_000);
   return;
  }
  for (const message of candidates) {
   const live = await env.DB.prepare("UPDATE mbox_sorting_jobs SET lease_until=? WHERE import_job_id=? AND lease_token=? RETURNING status").bind(Date.now() + LEASE_MS, id, lease).first<{ status: string }>();
   if (!live) return;
   if (live.status !== "running") break;
   if (!await env.DB.prepare(`SELECT id FROM messages WHERE id=? AND mailbox_id=? AND ${ELIGIBLE}`).bind(message.id, job.mailbox_id).first()) continue;
   const headers = await historicalHeaders(env, message);
   const result = await classifyIncomingMail(env, { mailboxId: job.mailbox_id, userId: access.mailbox.userId,
    sender: message.from_addr, recipient: message.to_addr, subject: message.subject,
    text: `${message.text_body ?? ""}\n${htmlToReadableText(message.html_body)}`.slice(0, 6000),
    spamScore: message.spam_score ?? 0, headers, aiBudgetCeiling: budget });
   // Historical suspect mail can be reviewed in Promotions without quarantining an old message.
   const decision = result.spam ? { ...result, category: "promotions" as const, spam: false, reason: "bulk_review", reviewRequired: true } : result;
   if (decision.reason === "disabled" || decision.reason === "observation") { await finish(env, id, lease, "paused", "sorting_disabled"); return; }
   if (decision.source === "fallback") {
    if (decision.reason === "daily_limit" || decision.fallbackReason === "daily_limit") {
     const date = new Date(); const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
     await finish(env, id, lease, "waiting", "daily_limit", nextDay); return;
    }
    throw new Error("AI sorting is temporarily unavailable; no category was changed. Retry the background job.");
   }
   // Never replay delivery, push notifications, spam learning or forwarding for historical mail.
   // A concurrent manual correction, archive/move or category change wins this conditional update.
   const recorded = JSON.stringify({ ...decision, backfillJobId: id, evaluatedAt: Date.now() });
   await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET category=?,sorting_decision=? WHERE id=? AND mailbox_id=? AND ${ELIGIBLE} AND EXISTS(SELECT 1 FROM mbox_sorting_jobs WHERE import_job_id=? AND lease_token=?)`)
     .bind(decision.category, recorded, message.id, job.mailbox_id, id, lease),
    env.DB.prepare("UPDATE mbox_sorting_jobs SET processed=processed+1,primary_count=primary_count+?,promotions_count=promotions_count+?,social_count=social_count+?,invoices_count=invoices_count+?,orders_count=orders_count+?,consecutive_failures=0,updated_at=?,lease_until=? WHERE import_job_id=? AND lease_token=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND sorting_decision=?)")
     .bind(Number(decision.category === "primary"), Number(decision.category === "promotions"), Number(decision.category === "social"), Number(decision.category === "invoices"), Number(decision.category === "orders"), Date.now(), Date.now() + LEASE_MS, id, lease, message.id, recorded),
   ]);
   if (Date.now() - now >= 15_000) break;
  }
  await finish(env, id, lease, "pending");
 } catch (error) {
  await env.DB.prepare("UPDATE mbox_sorting_jobs SET status=CASE WHEN status='paused' THEN 'paused' WHEN consecutive_failures>=2 THEN 'failed' ELSE 'waiting' END,consecutive_failures=consecutive_failures+1,error=?,wait_reason='retry',retry_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE import_job_id=? AND lease_token=?")
   .bind(error instanceof Error ? error.message.slice(0, 350) : "Archive sorting failed; retry to continue", Date.now() + 60_000, Date.now(), id, lease).run();
 }
 if ((await load(env, id))?.status === "pending") await enqueue(env, id);
}
export async function recoverMboxSortingJobs(env: CloudflareEnv) {
 if (!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mbox_sorting_jobs'").first()) return;
 const due = await env.DB.prepare("SELECT import_job_id FROM mbox_sorting_jobs WHERE status IN ('pending','waiting','running') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) ORDER BY updated_at LIMIT 5").bind(Date.now(), Date.now()).all<{ import_job_id: string }>();
 await Promise.allSettled(due.results.map(row => enqueue(env, row.import_job_id)));
}
