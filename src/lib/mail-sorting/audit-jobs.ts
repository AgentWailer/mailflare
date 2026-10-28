import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { getEmailAddress } from "@/lib/email/address";
import { createCategoryCorrection } from "./learning";
import { isMailCategory, type MailCategory, type SortingDecision } from "./categories";
import { classifyIncomingMail, DEFAULT_SORTING_SETTINGS } from "./classifier";
import { CONTENT_POLICY_VERSION, deterministicReview, isExplicitDecision, reviewText, shouldAuditWithAi, type ReviewMessage } from "./content-review";

export type ContentAuditJob = {
 id: string; user_id: string; mailbox_id: string; status: string; phase: "rules" | "ai";
 snapshot: number; after_row: number; total: number; processed: number; ai_processed: number;
 changed: number; review_count: number; error: string | null; retry_at: number; consecutive_failures: number;
 lease_token: string | null; lease_until: number; created_at: number; updated_at: number;
};
const ACTIVE = "'pending','running','waiting','paused'";
const ELIGIBLE = "direction='inbound' AND status IN ('received','archived')";
const AI_ELIGIBLE = `category IN ('primary','invoices','orders') AND snoozed_until IS NULL AND (sorting_decision IS NULL OR CASE WHEN json_valid(sorting_decision) THEN coalesce(json_extract(sorting_decision,'$.source'),'') NOT IN ('manual','reviewed','override') AND (coalesce(json_extract(sorting_decision,'$.policyVersion'),0)<${CONTENT_POLICY_VERSION} OR json_extract(sorting_decision,'$.source')='fallback') ELSE 1 END)`;
const LEASE_MS = 180_000;
const load = (env: Pick<CloudflareEnv, "DB">, id: string) => env.DB.prepare("SELECT * FROM mail_content_audit_jobs WHERE id=?").bind(id).first<ContentAuditJob>();
const enqueue = async (env: CloudflareEnv, id: string) => env.AGENT_QUEUE?.send({ kind: "mail.content-audit", jobId: id });
export function publicContentAudit(job: ContentAuditJob) {
 return { id: job.id, status: job.status, phase: job.phase, total: job.total, processed: job.processed,
  aiProcessed: job.ai_processed, changed: job.changed, reviewCount: job.review_count,
  error: job.error, retryAt: job.retry_at, updatedAt: job.updated_at };
}
export async function latestContentAudit(env: Pick<CloudflareEnv, "DB">, mailboxId: string) {
 return env.DB.prepare(`SELECT * FROM mail_content_audit_jobs WHERE mailbox_id=? ORDER BY CASE WHEN status IN (${ACTIVE}) THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1`).bind(mailboxId).first<ContentAuditJob>();
}
export async function startContentAudit(env: CloudflareEnv, user: SessionUser, mailboxId: string) {
 if (!(await getMailboxAccessLevel(getDb(env), user, mailboxId))?.canManage) throw new Error("Mailbox not found");
 if (!env.AGENT_QUEUE) throw new Error("Background queue is not configured");
 const existing = await latestContentAudit(env, mailboxId);
 if (existing && ["pending", "running", "waiting", "paused"].includes(existing.status) && existing.error !== "restore_requires_restart") return publicContentAudit(existing);
 const bound = await env.DB.prepare(`SELECT max(rowid) snapshot,count(*) total FROM messages WHERE mailbox_id=? AND ${ELIGIBLE}`).bind(mailboxId).first<{ snapshot: number | null; total: number }>();
 const id = newId("contentaudit"), now = Date.now();
 // Old sorter and new audit share a budget; only one historical AI consumer runs per mailbox.
 const statements = [env.DB.prepare("UPDATE mbox_sorting_jobs SET status='paused',wait_reason='sorting_disabled',updated_at=? WHERE mailbox_id=? AND status IN ('pending','running','waiting')").bind(now, mailboxId)];
 if (existing?.error === "restore_requires_restart") statements.push(env.DB.prepare("UPDATE mail_content_audit_jobs SET status='cancelled' WHERE id=?").bind(existing.id));
 statements.push(env.DB.prepare("INSERT INTO mail_content_audit_jobs(id,user_id,mailbox_id,snapshot,total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(id, user.id, mailboxId, bound?.snapshot ?? 0, bound?.total ?? 0, bound?.total ? "pending" : "completed", now, now));
 try { await env.DB.batch(statements); } catch (error) {
  const concurrent = await latestContentAudit(env, mailboxId);
  if (concurrent && ["pending", "running", "waiting", "paused"].includes(concurrent.status)) return publicContentAudit(concurrent);
  throw error;
 }
 if (bound?.total) await enqueue(env, id).catch(() => {});
 return publicContentAudit((await load(env, id))!);
}
export async function controlContentAudit(env: CloudflareEnv, user: SessionUser, mailboxId: string, action: "pause" | "resume") {
 if (!(await getMailboxAccessLevel(getDb(env), user, mailboxId))?.canManage) throw new Error("Mailbox not found");
 const job = await latestContentAudit(env, mailboxId);
 if (!job) throw new Error("Start a content audit first");
 if (action === "pause") await env.DB.prepare("UPDATE mail_content_audit_jobs SET status='paused',updated_at=? WHERE id=? AND status IN ('pending','running','waiting')").bind(Date.now(), job.id).run();
 else {
  if (job.error === "restore_requires_restart") throw new Error("Start a new audit after restoring a backup");
  await env.DB.prepare("UPDATE mail_content_audit_jobs SET status='pending',error=NULL,retry_at=0,consecutive_failures=0,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND status IN ('paused','failed','waiting') AND (lease_token IS NULL OR lease_until<?)").bind(Date.now(), job.id, Date.now()).run();
  if ((await load(env, job.id))?.status === "pending") await enqueue(env, job.id).catch(() => {});
 }
 return publicContentAudit((await load(env, job.id))!);
}

/** One atomic per-message checkpoint: redelivery never reapplies a correction or double-counts it. */
async function checkpoint(env: CloudflareEnv, job: ContentAuditJob, lease: string, message: ReviewMessage,
 decision: SortingDecision | null, issueReason: string | null = null, suggested: string | null = null) {
 const expected = "id=? AND mailbox_id=? AND category=? AND sorting_decision IS ? AND direction='inbound' AND status IN ('received','archived')";
 const guard = "EXISTS(SELECT 1 FROM mail_content_audit_jobs WHERE id=? AND lease_token=? AND status='running' AND after_row<?)";
 const args = [message.id, job.mailbox_id, message.category, message.sorting_decision, job.id, lease, message.row_id];
 const recorded = decision ? JSON.stringify({ ...decision, policyVersion: CONTENT_POLICY_VERSION, auditJobId: job.id,
  previousCategory: message.category, previousDecision: (() => { try { const old = JSON.parse(message.sorting_decision ?? "null"); return old?.auditJobId ? old.previousDecision : message.sorting_decision; } catch { return message.sorting_decision; } })(), evaluatedAt: Date.now() }) : null;
 const statements: D1PreparedStatement[] = [];
 if (issueReason) statements.push(env.DB.prepare(`INSERT INTO mail_content_audit_issues(id,job_id,message_id,category,suggested_category,expected_decision,reason,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE ${expected} AND ${guard}) ON CONFLICT(job_id,message_id) DO UPDATE SET suggested_category=excluded.suggested_category,reason=excluded.reason WHERE mail_content_audit_issues.status='pending'`)
  .bind(newId("auditissue"), job.id, message.id, message.category, isMailCategory(suggested) ? suggested : null, message.sorting_decision, issueReason, Date.now(), ...args));
 if (decision) statements.push(env.DB.prepare(`UPDATE messages SET category=?,sorting_decision=? WHERE ${expected} AND ${guard}`).bind(decision.category, recorded, ...args));
 statements.push(env.DB.prepare(`UPDATE mail_content_audit_jobs SET after_row=?,processed=processed+?,ai_processed=ai_processed+?,changed=changed+?,review_count=(SELECT count(*) FROM mail_content_audit_issues WHERE job_id=? AND status='pending'),updated_at=?,consecutive_failures=0 WHERE id=? AND lease_token=? AND status='running' AND after_row<?`)
  .bind(message.row_id, Number(job.phase === "rules"), Number(job.phase === "ai"), Number(!!decision && decision.category !== message.category), job.id, Date.now(), job.id, lease, message.row_id));
 // The counter is updated only when the guarded message write actually succeeded.
 if (decision && decision.category !== message.category) {
  statements[statements.length - 1] = env.DB.prepare(`UPDATE mail_content_audit_jobs SET after_row=?,processed=processed+?,ai_processed=ai_processed+?,changed=changed+CASE WHEN EXISTS(SELECT 1 FROM messages WHERE id=? AND sorting_decision=?) THEN 1 ELSE 0 END,review_count=(SELECT count(*) FROM mail_content_audit_issues WHERE job_id=? AND status='pending'),updated_at=?,consecutive_failures=0 WHERE id=? AND lease_token=? AND status='running' AND after_row<?`)
   .bind(message.row_id, Number(job.phase === "rules"), Number(job.phase === "ai"), message.id, recorded, job.id, Date.now(), job.id, lease, message.row_id);
 }
 await env.DB.batch(statements);
 job.after_row = message.row_id;
}
async function release(env: CloudflareEnv, id: string, lease: string, status: string, error: string | null = null, retryAt = 0) {
 await env.DB.prepare("UPDATE mail_content_audit_jobs SET status=CASE WHEN status='paused' THEN 'paused' ELSE ? END,error=?,retry_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?").bind(status, error, retryAt, Date.now(), id, lease).run();
}
export async function processContentAudit(env: CloudflareEnv, id: string) {
 const now = Date.now(), lease = newId("auditlease");
 const job = await env.DB.prepare("UPDATE mail_content_audit_jobs SET status='running',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status IN ('pending','running','waiting') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) RETURNING *").bind(lease, now + LEASE_MS, now, id, now, now).first<ContentAuditJob>();
 if (!job) return;
 let permanent = false;
 try {
  const [user] = await getDb(env).select().from(users).where(eq(users.id, job.user_id)).limit(1);
  if (!user || user.disabled) { permanent = true; throw new Error("Account is no longer authorized"); }
  const access = await getMailboxAccessLevel(getDb(env), user, job.mailbox_id);
  if (!access?.canManage) { permanent = true; throw new Error("Mailbox permission was revoked"); }
  const settings = await env.DB.prepare("SELECT mode,daily_limit FROM mailbox_sorting_settings WHERE mailbox_id=?").bind(job.mailbox_id).first<{ mode: string; daily_limit: number }>();
  if ((settings?.mode ?? DEFAULT_SORTING_SETTINGS.mode) !== "active") { await release(env, id, lease, "paused", "sorting_disabled"); return; }
  const ceiling = Math.floor((settings?.daily_limit ?? DEFAULT_SORTING_SETTINGS.dailyLimit) / 2);
  for (let step = 0; step < 10 && Date.now() - now < 20_000; step++) {
   const live = await env.DB.prepare("SELECT status FROM mail_content_audit_jobs WHERE id=? AND lease_token=?").bind(id, lease).first<{ status: string }>();
   if (!live || live.status !== "running") break;
   const rows = (await env.DB.prepare(`SELECT rowid row_id,id,from_addr,to_addr,subject,category,sorting_decision,substr(text_body,1,6000) text_body,substr(html_body,1,64000) html_body,snippet,spam_score,in_reply_to FROM messages INDEXED BY messages_mailbox_idx WHERE mailbox_id=? AND rowid>? AND rowid<=? AND ${ELIGIBLE} ${job.phase === "ai" ? `AND ${AI_ELIGIBLE}` : ""} ORDER BY rowid LIMIT 20`).bind(job.mailbox_id, job.after_row, job.snapshot).all<ReviewMessage>()).results;
   if (!rows.length) {
    if (job.phase === "rules") {
     const changed = await env.DB.prepare("UPDATE mail_content_audit_jobs SET phase='ai',after_row=0,updated_at=? WHERE id=? AND lease_token=? AND status='running' RETURNING id").bind(Date.now(), id, lease).first();
     if (changed) { job.phase = "ai"; job.after_row = 0; }
     else break;
     continue;
    }
    await release(env, id, lease, "completed"); return;
   }
   for (const message of rows) {
    let decision: SortingDecision | null = null, reason: string | null = null, suggestion: string | null = null;
    const routine = deterministicReview(message);
    if (isExplicitDecision(message)) {
     if (routine && routine.category !== message.category) { reason = "explicit_conflict"; suggestion = routine.category; }
    } else if (routine) decision = { ...routine, policyVersion: CONTENT_POLICY_VERSION };
    else if (job.phase === "rules" && message.category === "social" &&
     ["inmail-hit-reply@linkedin.com", "messages-noreply@linkedin.com"].includes(getEmailAddress(message.from_addr).toLowerCase())) {
     reason = "direct_message_review"; suggestion = "primary";
    }
    else if (job.phase === "ai" && shouldAuditWithAi(message)) {
     const result = await classifyIncomingMail(env, { mailboxId: job.mailbox_id, userId: access.mailbox.userId, sender: message.from_addr, recipient: message.to_addr,
      subject: message.subject, text: reviewText(message), spamScore: message.spam_score ?? 0, headers: message.in_reply_to ? { "in-reply-to": message.in_reply_to } : {}, aiBudgetCeiling: ceiling, conservativeReview: true });
     if (result.reason === "daily_limit") {
      const date = new Date(); await release(env, id, lease, "waiting", "daily_limit", Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)); return;
     }
     if (["disabled", "observation"].includes(result.reason)) { await release(env, id, lease, "paused", "sorting_disabled"); return; }
     const probability = result.probabilities?.[result.category] ?? 0;
     // The existing live-mail resolver is deliberately broader. Historical changes require strong,
     // consistent evidence and never create Spam/Trash or a blanket sender override.
     if (result.source === "rule" || result.source === "override" || result.source === "clef" && !result.spam && !result.reviewRequired && probability >= 0.90 && result.suggestedCategory === result.category) decision = result;
     else { reason = result.source === "fallback" ? "evaluation_unavailable" : "uncertain"; suggestion = result.suggestedCategory ?? result.category; }
    }
    await checkpoint(env, job, lease, message, decision, reason, suggestion);
    if (Date.now() - now >= 20_000) break;
   }
  }
  await release(env, id, lease, "pending");
 } catch (error) {
  await env.DB.prepare("UPDATE mail_content_audit_jobs SET consecutive_failures=consecutive_failures+1 WHERE id=? AND lease_token=?").bind(id, lease).run();
  await release(env, id, lease, permanent || job.consecutive_failures >= 7 ? "failed" : "waiting", (error instanceof Error ? error.message : "Content audit failed").slice(0, 350), Date.now() + 60_000);
 }
 if ((await load(env, id))?.status === "pending") await enqueue(env, id).catch(() => {});
}
export async function recoverContentAudits(env: CloudflareEnv) {
 if (!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mail_content_audit_jobs'").first()) return;
 const due = await env.DB.prepare("SELECT id FROM mail_content_audit_jobs WHERE status IN ('pending','running','waiting') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) ORDER BY updated_at LIMIT 5").bind(Date.now(), Date.now()).all<{ id: string }>();
 await Promise.allSettled(due.results.map(job => enqueue(env, job.id)));
}

/** Confirming a review writes both the category and the learning example in one transaction. */
export async function reviewAuditIssue(env: CloudflareEnv, user: SessionUser, mailboxId: string, issueId: string, category: MailCategory | null) {
 if (!(await getMailboxAccessLevel(getDb(env), user, mailboxId))?.canManage) return "missing";
 const issue = await env.DB.prepare("SELECT i.*,m.from_addr,m.subject,substr(m.text_body,1,6000) text_body,substr(m.html_body,1,64000) html_body,m.snippet,m.sorting_decision,m.category current_category,m.status message_status FROM mail_content_audit_issues i JOIN mail_content_audit_jobs j ON j.id=i.job_id JOIN messages m ON m.id=i.message_id AND m.mailbox_id=j.mailbox_id WHERE i.id=? AND j.mailbox_id=? AND i.status='pending'").bind(issueId, mailboxId).first<{ id: string; job_id: string; message_id: string; category: string; expected_decision: string | null; sorting_decision: string | null; current_category: string; message_status: string; from_addr: string; subject: string | null; text_body: string | null; html_body: string | null; snippet: string | null }>();
 if (!issue) return "missing";
 if (category && (issue.sorting_decision !== issue.expected_decision || issue.current_category !== issue.category || !["received", "archived"].includes(issue.message_status))) return "stale";
 const statements: D1PreparedStatement[] = [];
 const recorded = category ? JSON.stringify(createCategoryCorrection(category, issue.sorting_decision, user.id)) : null;
 if (category) {
  statements.push(env.DB.prepare("UPDATE messages SET category=?,sorting_decision=? WHERE id=? AND mailbox_id=? AND category=? AND sorting_decision IS ? AND status IN ('received','archived') AND EXISTS(SELECT 1 FROM mail_content_audit_issues WHERE id=? AND status='pending')").bind(category, recorded, issue.message_id, mailboxId, issue.category, issue.expected_decision, issue.id));
  statements.push(env.DB.prepare("INSERT INTO mail_sorting_feedback(id,mailbox_id,message_id,sender,subject,category,corrected_at,excerpt,source) SELECT ?,?,?,?,?,?,?,?,'user' WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND sorting_decision=?) ON CONFLICT(mailbox_id,message_id) DO UPDATE SET category=excluded.category,corrected_at=excluded.corrected_at,excerpt=excluded.excerpt,source='user'").bind(newId("sfb"), mailboxId, issue.message_id, getEmailAddress(issue.from_addr).toLowerCase(), issue.subject?.slice(0, 200) ?? "", category, new Date().toISOString(), reviewText(issue).slice(0, 1000), issue.message_id, recorded));
 }
 statements.push(env.DB.prepare(`UPDATE mail_content_audit_issues SET status=?,reviewed_at=? WHERE id=? AND status='pending' ${category ? "AND EXISTS(SELECT 1 FROM messages WHERE id=? AND sorting_decision=?)" : ""}`).bind(category ? "accepted" : "dismissed", Date.now(), issue.id, ...(category ? [issue.message_id, recorded] : [])));
 statements.push(env.DB.prepare("UPDATE mail_content_audit_jobs SET review_count=(SELECT count(*) FROM mail_content_audit_issues WHERE job_id=? AND status='pending') WHERE id=?").bind(issue.job_id, issue.job_id));
 const results = await env.DB.batch(statements);
 return results[results.length - 2].meta.changes ? "ok" : "stale";
}
