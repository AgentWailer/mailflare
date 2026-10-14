import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { decryptCredentials, PaperlessError, pollPaperlessTask, uploadPdf } from "./client";
export type PaperlessConnection = {mailbox_id:string;user_id:string;base_url:string;credentials:string;enabled:number;label_id:string|null;processed_label_id:string|null;created_at:number;updated_at:number};
export type PaperlessJob = {id:string;mailbox_id:string;user_id:string;message_id:string;attachment_id:string;base_url:string;status:string;task_id:string|null;document_id:number|null;error:string|null;attempts:number;retry_at:number;lease_token:string|null;lease_until:number;created_at:number;updated_at:number};
export const loadConnection = (env: Pick<CloudflareEnv,"DB">, mailboxId: string) => env.DB.prepare("SELECT * FROM paperless_connections WHERE mailbox_id=?").bind(mailboxId).first<PaperlessConnection>();
const PDF = "(lower(a.content_type) LIKE 'application/pdf%' OR lower(a.filename) LIKE '%.pdf')";
/** Append to the same transaction as adding a label. No restore/import triggers or archive-wide scans. */
export function paperlessOutbox(env: CloudflareEnv, mailboxId: string, messageId: string, actorId: string | null, requestedLabels: string[]) {
 if (!requestedLabels.length) return [];
 // Check the requested IDs in JS-generated bounded SQL; labels are parameterized, never interpolated.
 return [env.DB.prepare(`INSERT OR IGNORE INTO paperless_jobs(id,mailbox_id,user_id,message_id,attachment_id,base_url,status,created_at,updated_at)
 SELECT 'paperless_'||a.id,c.mailbox_id,coalesce(?,c.user_id),m.id,a.id,c.base_url,'pending',?,?
 FROM paperless_connections c JOIN messages m ON m.mailbox_id=c.mailbox_id JOIN message_attachments a ON a.message_id=m.id
 WHERE c.mailbox_id=? AND m.id=? AND c.enabled=1 AND c.label_id IN (${requestedLabels.map(()=>"?").join(",")})
 AND m.status IN ('received','archived') AND a.trashed_at IS NULL AND ${PDF}
 AND (m.folder_id=c.label_id OR EXISTS(SELECT 1 FROM message_labels WHERE message_id=m.id AND folder_id=c.label_id))
 AND NOT EXISTS(SELECT 1 FROM message_labels WHERE message_id=m.id AND folder_id=c.processed_label_id)
 AND m.folder_id IS NOT c.processed_label_id`).bind(actorId,Date.now(),Date.now(),mailboxId,messageId,...requestedLabels)];
}
export async function enqueuePaperlessMessage(env: CloudflareEnv, mailboxId: string, messageId: string) {
 if (!env.AGENT_QUEUE) return;
 const rows = (await env.DB.prepare("SELECT id FROM paperless_jobs WHERE mailbox_id=? AND message_id=? AND status='pending' LIMIT 10").bind(mailboxId,messageId).all<{id:string}>()).results;
 await Promise.allSettled(rows.map(row=>env.AGENT_QUEUE!.send({kind:"paperless.document",jobId:row.id})));
}
async function release(env: CloudflareEnv, id: string, lease: string, status: string, error: string|null, retryAt=0) {
 await env.DB.prepare("UPDATE paperless_jobs SET status=?,error=?,retry_at=?,attempts=CASE WHEN ? IS NULL THEN 0 ELSE attempts END,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?").bind(status,error,retryAt,error,Date.now(),id,lease).run();
}
async function complete(env: CloudflareEnv, job: PaperlessJob, lease: string, documentId: number) {
 const now=Date.now();
 await env.DB.batch([
  env.DB.prepare("UPDATE paperless_jobs SET status='completed',document_id=?,error=NULL,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?").bind(documentId,now,job.id,lease),
  // A single completed PDF is insufficient: every remaining PDF must have a completed job.
  env.DB.prepare(`INSERT OR IGNORE INTO message_labels(message_id,folder_id)
   SELECT m.id,c.processed_label_id FROM messages m JOIN paperless_connections c ON c.mailbox_id=m.mailbox_id
   WHERE m.id=? AND c.base_url=? AND c.processed_label_id IS NOT NULL AND c.enabled=1
   AND EXISTS(SELECT 1 FROM paperless_jobs WHERE id=? AND status='completed' AND document_id=?)
   AND (m.folder_id=c.label_id OR EXISTS(SELECT 1 FROM message_labels WHERE message_id=m.id AND folder_id=c.label_id))
   AND m.status IN ('received','archived') AND NOT EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.trashed_at IS NULL AND ${PDF}
    AND NOT EXISTS(SELECT 1 FROM paperless_jobs j WHERE j.attachment_id=a.id AND j.mailbox_id=c.mailbox_id AND j.base_url=c.base_url AND j.status='completed'))`)
   .bind(job.message_id,job.base_url,job.id,documentId),
 ]);
}
export async function processPaperlessJob(env: CloudflareEnv, id: string) {
 const now=Date.now(),lease=newId("paperlesslease");
 const job = await env.DB.prepare("UPDATE paperless_jobs SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status IN ('pending','waiting') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) RETURNING *").bind(lease,now+180_000,now,id,now,now).first<PaperlessJob>();
 if (!job) return;
 let uploading=false;
 try {
  const connection=await loadConnection(env,job.mailbox_id);
  if (!connection || !connection.enabled || connection.base_url !== job.base_url) { await release(env,id,lease,"paused","connection_disabled");return; }
  if (!connection.label_id || !connection.processed_label_id) throw new PaperlessError("invalid_label");
  const [user]=await getDb(env).select().from(users).where(eq(users.id,job.user_id)).limit(1);
  if (!user || user.disabled || !(await getMailboxAccessLevel(getDb(env),user,job.mailbox_id))?.canManage) throw new PaperlessError("permission_revoked");
  const attachment=await env.DB.prepare(`SELECT a.filename,a.r2_key FROM message_attachments a JOIN messages m ON m.id=a.message_id
   WHERE a.id=? AND m.id=? AND m.mailbox_id=? AND a.trashed_at IS NULL AND m.status IN ('received','archived')
   AND (m.folder_id=? OR EXISTS(SELECT 1 FROM message_labels WHERE message_id=m.id AND folder_id=?))`).bind(job.attachment_id,job.message_id,job.mailbox_id,connection.label_id,connection.label_id).first<{filename:string;r2_key:string}>();
  if (!attachment) { await release(env,id,lease,"cancelled","label_or_attachment_removed");return; }
  const credentials=await decryptCredentials(env,job.mailbox_id,connection.base_url,connection.credentials);
  if (job.task_id) {
   const task=await pollPaperlessTask(connection.base_url,credentials,job.task_id);
   if (task.done && task.documentId) { await complete(env,job,lease,task.documentId);return; }
   if (Date.now()-job.created_at>7*86400_000) throw new PaperlessError("task_not_confirmed");
   await release(env,id,lease,"waiting",null,Date.now()+30_000);
  } else {
   const claimed=await env.DB.prepare("UPDATE paperless_jobs SET status='uploading',attempts=attempts+1 WHERE id=? AND lease_token=? RETURNING id").bind(id,lease).first();
   if (!claimed) return;
   uploading=true;
   const taskId=await uploadPdf(env,connection.base_url,credentials,attachment);
   await env.DB.prepare("UPDATE paperless_jobs SET task_id=?,status='waiting',error=NULL,attempts=0,retry_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?").bind(taskId,Date.now()+10_000,Date.now(),id,lease).run();
  }
  await env.AGENT_QUEUE?.send({kind:"paperless.document",jobId:id},{delaySeconds:30}).catch(()=>{});
 } catch (error) {
  const known=error instanceof PaperlessError;
  const code=known?error.code:uploading?"upload_uncertain":"internal_error";
  const ambiguous=known?error.ambiguous:uploading;
  const attempts=job.attempts+1;
  const retryable=known?error.retryable:!uploading;
  const retry=retryable && attempts<5;
  await env.DB.prepare("UPDATE paperless_jobs SET attempts=? WHERE id=? AND lease_token=?").bind(attempts,id,lease).run();
  await release(env,id,lease,ambiguous?"uncertain":retry?(job.task_id?"waiting":"pending"):"failed",code,retry?Date.now()+Math.min(3600_000,60_000*2**attempts):0);
 }
}
/** Cron recovers committed outbox rows and stalled consumers, independently of a browser. */
export async function recoverPaperlessJobs(env: CloudflareEnv) {
 if (!env.AGENT_QUEUE) return;
 await env.DB.prepare("UPDATE paperless_jobs SET status='uncertain',error='upload_uncertain',lease_token=NULL,lease_until=0,updated_at=? WHERE status='uploading' AND lease_until<?").bind(Date.now(),Date.now()).run();
 const rows=(await env.DB.prepare(`SELECT j.id FROM paperless_jobs j JOIN paperless_connections c ON c.mailbox_id=j.mailbox_id
 WHERE j.status IN ('pending','waiting') AND j.retry_at<=? AND j.lease_until<? AND c.enabled=1 AND c.base_url=j.base_url ORDER BY j.retry_at,j.created_at LIMIT 20`).bind(Date.now(),Date.now()).all<{id:string}>()).results;
 await Promise.allSettled(rows.map(row=>env.AGENT_QUEUE!.send({kind:"paperless.document",jobId:row.id})));
}
