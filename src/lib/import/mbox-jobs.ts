import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, driveUploadParts, folders, users } from "@/db/schema";
import { assertAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { getImportMessagePlacement } from "./destination";
import { importMessageToMailbox } from "./service";
import { mboxPlacement } from "./mbox-labels";
import { readMboxRecords, type MboxSource } from "./mbox-stream";
import { getMboxSortingJobs } from "./mbox-sorting";
import { ImportMessageError, importErrorMessage, isInvalidImportMessage, isTransientImportError } from "./errors";

export type MboxJob = {
 id: string; user_id: string; mailbox_id: string; object_key: string; object_etag: string; object_size: number;
 byte_offset: number; processed: number; imported: number; skipped: number;
 status: "pending" | "running" | "paused" | "failed" | "completed";
 error: string | null; blocked_next_offset: number | null; lease_token: string | null; lease_until: number;
 scan_offset: number; scan_size: number; scan_starts_line: number; retry_at: number; consecutive_failures: number;
 created_at: number; updated_at: number;
};
const LEASE_MS = 5 * 60_000;
const MAX_BATCH_MESSAGES = 25;
const PRIVATE_PREFIX = "mbox-imports/";
export function publicMboxJob(job: MboxJob) {
 return { id: job.id, mailboxId: job.mailbox_id, objectKey: job.object_key, size: job.object_size, offset: job.byte_offset,
  processed: job.processed, imported: job.imported, skipped: job.skipped, status: job.status, error: job.error, retryAt: job.retry_at,
  canSkip: job.status === "failed" && !job.lease_token && job.blocked_next_offset !== null,
  progress: job.status === "completed" ? 100 : Math.floor(job.byte_offset / job.object_size * 100) };
}
async function loadJob(env: CloudflareEnv, id: string) {
 return env.DB.prepare("SELECT * FROM mbox_import_jobs WHERE id=?").bind(id).first<MboxJob>();
}
async function checkAccess(env: CloudflareEnv, user: SessionUser, mailboxId: string) {
 assertAdmin(user);
 const access = await getMailboxAccessLevel(getDb(env), user, mailboxId);
 if (!access?.canManage || access.mailbox.disabled) throw new Error("Mailbox not found or import permission denied");
 return access;
}
export async function getOwnedMboxJob(env: CloudflareEnv, user: SessionUser, id: string) {
 const job = await loadJob(env, id);
 if (!job) throw new Error("Import job not found");
 await checkAccess(env, user, job.mailbox_id);
 return job;
}
export async function listMboxJobs(env: CloudflareEnv, user: SessionUser, mailboxId: string) {
 await checkAccess(env, user, mailboxId);
 const jobs = await env.DB.prepare("SELECT * FROM mbox_import_jobs WHERE mailbox_id=? ORDER BY created_at DESC LIMIT 30").bind(mailboxId).all<MboxJob>();
 const sorting = await getMboxSortingJobs(env, mailboxId);
 const issues = await env.DB.prepare("SELECT i.import_job_id,COUNT(*) AS total,SUM(i.status='pending') AS pending FROM mbox_import_issues i JOIN mbox_import_jobs j ON j.id=i.import_job_id WHERE j.mailbox_id=? GROUP BY i.import_job_id").bind(mailboxId).all<{ import_job_id: string; total: number; pending: number }>();
 const issueCounts = new Map(issues.results.map(item => [item.import_job_id, { total: item.total, pending: item.pending }]));
 return jobs.results.map(job => ({ ...publicMboxJob(job), issues: issueCounts.get(job.id) ?? { total: 0, pending: 0 }, sorting: sorting.get(job.id) ?? null }));
}
async function enqueue(env: CloudflareEnv, id: string, delaySeconds = 0) {
 if (!env.AGENT_QUEUE) throw new Error("The background queue is not configured");
 await env.AGENT_QUEUE.send({ kind: "import.mbox", jobId: id }, { delaySeconds });
}
export async function createMboxJob(env: CloudflareEnv, user: SessionUser, mailboxId: string, objectKey: string) {
 await checkAccess(env, user, mailboxId);
 if (!env.AGENT_QUEUE) throw new Error("The background queue is not configured");
 if (objectKey.length > 1024 || /[\x00-\x1f]/.test(objectKey) || objectKey.split('/').some(part => part === '..')) throw new Error("Invalid MBOX object key");
 const db = getDb(env);
 let driveSource: typeof driveItems.$inferSelect | undefined;
 if (objectKey.startsWith("drive/")) {
  const [item] = await db.select().from(driveItems).where(and(eq(driveItems.r2Key, objectKey), eq(driveItems.ownerId, user.id))).limit(1);
  if (!item || item.kind !== "file" || item.trashedAt || !/\.m(?:box|bx)$/i.test(item.name)) throw new Error("Select an untrashed MBOX file from your own Drive");
  driveSource = item;
 } else if (!objectKey.startsWith(PRIVATE_PREFIX) || !/\.m(?:box|bx)$/i.test(objectKey)) {
  throw new Error("Use a .mbox object inside mbox-imports/ or an MBOX file from your own Drive");
 }
 const object = await env.BUCKET.head(objectKey);
 if (!object || !object.size || !object.etag) throw new Error("MBOX object not found. Finish its multipart upload before starting the import.");
 if (driveSource) {
  if (object.size !== driveSource.size) throw new Error("The completed Drive object does not match the declared file size; finish or verify the upload first");
  // A verified S3 completion outside Mailflare leaves Drive's pending marker behind.
  // Publish it only after the full object exists; never copy the archive or grant access to another owner's Drive.
  if (driveSource.uploadId) {
   await db.batch([
    db.update(driveItems).set({ uploadId: null, uploadPartSize: null, uploadFingerprint: null, updatedAt: new Date() }).where(and(eq(driveItems.id, driveSource.id), eq(driveItems.ownerId, user.id), eq(driveItems.uploadId, driveSource.uploadId))),
    db.delete(driveUploadParts).where(eq(driveUploadParts.itemId, driveSource.id)),
   ]);
  }
 }
 const now = Date.now(), id = newId("mboximport");
 await env.DB.prepare("INSERT INTO mbox_import_jobs(id,user_id,mailbox_id,object_key,object_etag,object_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
  .bind(id, user.id, mailboxId, objectKey, object.etag, object.size, now, now).run();
 const job = await env.DB.prepare("SELECT * FROM mbox_import_jobs WHERE mailbox_id=? AND object_key=? AND status<>'completed' LIMIT 1").bind(mailboxId, objectKey).first<MboxJob>();
 if (!job) throw new Error("Retry starting the import");
 if (job.status === "pending") await enqueue(env, job.id);
 return publicMboxJob(job);
}
export async function controlMboxJob(env: CloudflareEnv, user: SessionUser, id: string, action: "pause" | "resume" | "skip") {
 const job = await loadJob(env, id);
 if (!job) throw new Error("Import job not found");
 await checkAccess(env, user, job.mailbox_id);
 if (job.status === "completed") return publicMboxJob(job);
 if (action === "pause") {
  await env.DB.prepare("UPDATE mbox_import_jobs SET status='paused',updated_at=? WHERE id=? AND status IN ('pending','running')").bind(Date.now(), id).run();
 } else {
  if (job.lease_token && job.lease_until > Date.now()) throw new Error("Wait for the current message to finish before resuming");
  if (action === "skip") {
   if (!publicMboxJob(job).canSkip) throw new Error("Only the failed message can be explicitly skipped");
   const skipLease = newId("skip");
   const claimed = await env.DB.prepare("UPDATE mbox_import_jobs SET lease_token=?,lease_until=? WHERE id=? AND status='failed' AND lease_token IS NULL AND byte_offset=? RETURNING id")
    .bind(skipLease, Date.now() + LEASE_MS, id, job.byte_offset).first();
   if (!claimed) throw new Error("Import changed; reload before skipping");
   try {
    await quarantineMboxMessage(env, job, skipLease, job.blocked_next_offset!, job.blocked_next_offset! - job.byte_offset, "explicit_skip", job.error ?? "Manually skipped interrupted message", true);
   } catch (error) {
    await env.DB.prepare("UPDATE mbox_import_jobs SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?").bind(id, skipLease).run();
    throw error;
   }
  } else {
   await env.DB.prepare("UPDATE mbox_import_jobs SET status='pending',retry_at=0,lease_token=NULL,lease_until=0,error=NULL,blocked_next_offset=NULL,updated_at=? WHERE id=? AND status<>'completed' AND (lease_token IS NULL OR lease_until<?)")
    .bind(Date.now(), id, Date.now()).run();
   await enqueue(env, id);
  }
 }
 const saved = await loadJob(env, id); if (!saved) throw new Error("Import job disappeared");
 return publicMboxJob(saved);
}

/** R2 Range reads keep both network requests and memory bounded even for a 10 GiB object. */
export function r2MboxSource(env: Pick<CloudflareEnv, "BUCKET">, job: Pick<MboxJob, "object_key" | "object_etag" | "object_size">): MboxSource {
 return { size: job.object_size, slice(start, end) { return { async arrayBuffer() {
  const object = await env.BUCKET.get(job.object_key, { range: { offset: start, length: end - start }, onlyIf: { etagMatches: job.object_etag } });
  if (!object || object.etag !== job.object_etag || object.size !== job.object_size || !("body" in object)) throw new Error("MBOX object changed or disappeared. Restore the original object before resuming.");
  const bytes = new Uint8Array(end - start), reader = object.body.getReader(); let count = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break;
   if (count + next.value.length > bytes.length) throw new Error("Storage did not honor the bounded range request");
   bytes.set(next.value, count); count += next.value.length;
  } } finally { await reader.cancel(); reader.releaseLock(); }
  if (count !== bytes.length) throw new Error("Incomplete MBOX range read; resume the import");
  return bytes.buffer;
 } }; } };
}

/** The issue and forward checkpoint commit together; the source bytes are never deleted. */
async function quarantineMboxMessage(env: CloudflareEnv, job: MboxJob, lease: string, nextOffset: number, size: number, reason: string, error: string, pause = false) {
 const stagedId = `msg_mbox_${job.id}_${job.byte_offset}`;
 const staged = await env.DB.prepare("SELECT raw_r2_key FROM messages WHERE id=? AND status='importing'").bind(stagedId).first<{ raw_r2_key: string | null }>();
 if (staged) await deleteMessageWithObjects(env, getDb(env), stagedId, staged.raw_r2_key);
 const results = await env.DB.batch([
  env.DB.prepare("INSERT INTO mbox_import_issues(id,import_job_id,byte_offset,next_offset,message_size,reason,error,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mbox_import_jobs WHERE id=? AND lease_token=? AND byte_offset=?) ON CONFLICT(import_job_id,byte_offset) DO NOTHING")
   .bind(`mboxissue_${job.id}_${job.byte_offset}`, job.id, job.byte_offset, nextOffset, size, reason, error, Date.now(), job.id, lease, job.byte_offset),
  env.DB.prepare("UPDATE mbox_import_jobs SET byte_offset=?,scan_offset=0,scan_size=0,scan_starts_line=1,retry_at=0,consecutive_failures=0,processed=processed+1,skipped=skipped+1,error=NULL,blocked_next_offset=NULL,updated_at=?,status=CASE WHEN ? THEN 'paused' ELSE status END,lease_token=CASE WHEN ? THEN NULL ELSE lease_token END,lease_until=CASE WHEN ? THEN 0 ELSE lease_until END WHERE id=? AND lease_token=? AND byte_offset=? RETURNING *")
   .bind(nextOffset, Date.now(), pause ? 1 : 0, pause ? 1 : 0, pause ? 1 : 0, job.id, lease, job.byte_offset),
 ]);
 return results[1].results[0] as MboxJob | undefined;
}

export async function processMboxJob(env: CloudflareEnv, id: string) {
 const lease = newId("lease"), now = Date.now();
 let job = await env.DB.prepare("UPDATE mbox_import_jobs SET status='running',lease_token=?,lease_until=?,error=NULL,blocked_next_offset=NULL,updated_at=? WHERE id=? AND status IN ('pending','running') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) RETURNING *")
  .bind(lease, now + LEASE_MS, now, id, now, now).first<MboxJob>();
 if (!job) return;
 let blockedOffset: number | null = null;
 try {
  const [user] = await getDb(env).select().from(users).where(eq(users.id, job.user_id)).limit(1);
  if (!user || user.disabled) throw new Error("Import administrator is disabled or deleted");
  const access = await checkAccess(env, user, job.mailbox_id);
  const object = await env.BUCKET.head(job.object_key);
  if (!object || object.etag !== job.object_etag || object.size !== job.object_size) throw new Error("MBOX object changed or disappeared. Restore the original object before resuming.");
  const known = new Map((await getDb(env).select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.mailboxId, job.mailbox_id))).map(folder => [folder.name, folder.id]));
  let count = 0;
  for await (const record of readMboxRecords(r2MboxSource(env, job), job.scan_offset || job.byte_offset, { scanLimit: 32 * 1024 * 1024, ...(job.scan_offset ? { discard: { size: job.scan_size, startsLine: !!job.scan_starts_line } } : {}) })) {
   blockedOffset = record.scan ? null : record.nextOffset;
   // Check pause/ownership and renew the lease in one round trip.
   const live = await env.DB.prepare("UPDATE mbox_import_jobs SET lease_until=? WHERE id=? AND lease_token=? RETURNING *")
    .bind(Date.now() + LEASE_MS, id, lease).first<MboxJob>();
   if (!live || live.lease_token !== lease) return;
   if (live.status !== "running") break;
   if (record.scan) {
    const saved = await env.DB.prepare("UPDATE mbox_import_jobs SET scan_offset=?,scan_size=?,scan_starts_line=?,updated_at=? WHERE id=? AND lease_token=? RETURNING *")
     .bind(record.nextOffset, record.size, record.scan.startsLine ? 1 : 0, Date.now(), id, lease).first<MboxJob>();
    if (!saved) return; job = saved; count++; blockedOffset = null; break;
   }
   try {
   if (!record.raw) throw new ImportMessageError("Message exceeds the 20 MiB import processing limit; the original message is retained for review.");
   const raw = await record.raw.arrayBuffer(), placement = mboxPlacement(raw);
   placement.metadata.sourceKey = `r2mbox:${job.object_etag}:${job.object_key}:${job.byte_offset}`;
   const imported = await importMessageToMailbox(env, { userId: placement.metadata.direction === "outbound" ? user.id : access.mailbox.userId,
    mailboxId: job.mailbox_id, filename: `${job.object_key}@${job.byte_offset}`, raw,
    destination: placement.destination, metadata: placement.metadata, stagingId: `msg_mbox_${id}_${job.byte_offset}`, keepStaged: true });
   const labelIds: string[] = [];
   for (const name of placement.labels) {
    let folderId = known.get(name);
    if (!folderId) {
     const db = getDb(env);
     await db.insert(folders).values({ id: newId("fld"), userId: access.mailbox.userId, mailboxId: job.mailbox_id, name, color: "#2563eb" }).onConflictDoNothing();
     const [saved] = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.mailboxId, job.mailbox_id), eq(folders.name, name))).limit(1);
     if (!saved) throw new Error("Unable to preserve the imported label");
     folderId = saved.id; known.set(name, folderId);
    }
    labelIds.push(folderId);
   }
   const labelWrites: D1PreparedStatement[] = [];
   for (let start = 0; start < labelIds.length; start += 40) {
    const ids = labelIds.slice(start, start + 40);
    // Validate mailbox ownership inside the insert, including labels deleted during the import.
    labelWrites.push(env.DB.prepare(`INSERT INTO message_labels(message_id,folder_id) SELECT ?,id FROM folders WHERE mailbox_id=? AND id IN (${ids.map(() => "?").join(",")}) AND EXISTS(SELECT 1 FROM mbox_import_jobs WHERE id=? AND lease_token=?) ON CONFLICT DO NOTHING`)
     .bind(imported.id, job.mailbox_id, ...ids, id, lease));
   }
   // Store labels, publish the message and checkpoint together after all objects are complete.
   const results = await env.DB.batch([
    ...labelWrites,
    env.DB.prepare("UPDATE messages SET status=? WHERE id=? AND status='importing' AND EXISTS(SELECT 1 FROM mbox_import_jobs WHERE id=? AND lease_token=?)")
     .bind(getImportMessagePlacement(placement.destination).status, imported.id, id, lease),
    env.DB.prepare("UPDATE mbox_import_jobs SET byte_offset=?,scan_offset=0,scan_size=0,scan_starts_line=1,retry_at=0,consecutive_failures=0,processed=processed+1,imported=imported+?,skipped=skipped+?,updated_at=?,lease_until=? WHERE id=? AND lease_token=? RETURNING *")
     .bind(record.nextOffset, imported.created ? 1 : 0, imported.created ? 0 : 1, Date.now(), Date.now() + LEASE_MS, id, lease),
   ]);
   const saved = results[results.length - 1].results[0] as MboxJob | undefined;
   if (!saved) return; job = saved; blockedOffset = null;
   } catch (error) {
    if (!isInvalidImportMessage(error)) throw error;
    const saved = await quarantineMboxMessage(env, job, lease, record.nextOffset, record.size, record.raw ? "invalid_message" : "oversized", importErrorMessage(error));
    if (!saved) return; job = saved; blockedOffset = null;
   }
   if (++count >= MAX_BATCH_MESSAGES || Date.now() - now >= 15000) break;
  }
  const live = await loadJob(env, id);
  if (!count && live?.status === "running" && job.byte_offset < job.object_size) throw new Error("No complete messages found in this MBOX archive");
  await env.DB.prepare("UPDATE mbox_import_jobs SET status=CASE WHEN byte_offset>=object_size THEN 'completed' WHEN status='paused' THEN 'paused' ELSE 'pending' END,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?").bind(Date.now(), id, lease).run();
 } catch (error) {
  const message = importErrorMessage(error), retry = isTransientImportError(error);
  const failures = job.consecutive_failures + 1;
  const delay = Math.min(900, 60 * 2 ** Math.min(failures - 1, 4));
  await env.DB.prepare("UPDATE mbox_import_jobs SET status=CASE WHEN status='paused' THEN 'paused' WHEN ? THEN 'pending' ELSE 'failed' END,error=?,retry_at=?,consecutive_failures=?,blocked_next_offset=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?")
   .bind(retry ? 1 : 0, message, retry ? Date.now() + delay * 1000 : 0, failures, blockedOffset, Date.now(), id, lease).run();
 }
 const saved = await loadJob(env, id);
 if (saved?.status === "pending") await enqueue(env, id, Math.max(0, Math.ceil((saved.retry_at - Date.now()) / 1000)));
}

export async function recoverMboxJobs(env: CloudflareEnv) {
 const due = await env.DB.prepare("SELECT id FROM mbox_import_jobs WHERE status IN ('pending','running') AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) ORDER BY updated_at ASC LIMIT 5").bind(Date.now(), Date.now()).all<{ id: string }>();
 await Promise.allSettled(due.results.map(job => enqueue(env, job.id)));
}
