import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messageLabels, users } from "@/db/schema";
import { assertAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { getImportMessagePlacement } from "./destination";
import { validLabelIds } from "@/lib/mail-sorting/labels";
import { importMessageToMailbox } from "./service";
import { mboxPlacement } from "./mbox-labels";
import { readMboxRecords, type MboxSource } from "./mbox-stream";

export type MboxJob = {
 id: string; user_id: string; mailbox_id: string; object_key: string; object_etag: string; object_size: number;
 byte_offset: number; processed: number; imported: number; skipped: number;
 status: "pending" | "running" | "paused" | "failed" | "completed";
 error: string | null; blocked_next_offset: number | null; lease_token: string | null; lease_until: number;
 created_at: number; updated_at: number;
};
const LEASE_MS = 5 * 60_000;
const PRIVATE_PREFIX = "mbox-imports/";
export function publicMboxJob(job: MboxJob) {
 return { id: job.id, mailboxId: job.mailbox_id, objectKey: job.object_key, size: job.object_size, offset: job.byte_offset,
  processed: job.processed, imported: job.imported, skipped: job.skipped, status: job.status, error: job.error,
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
export async function listMboxJobs(env: CloudflareEnv, user: SessionUser, mailboxId: string) {
 await checkAccess(env, user, mailboxId);
 return (await env.DB.prepare("SELECT * FROM mbox_import_jobs WHERE mailbox_id=? ORDER BY created_at DESC LIMIT 30").bind(mailboxId).all<MboxJob>()).results.map(publicMboxJob);
}
async function enqueue(env: CloudflareEnv, id: string) {
 if (!env.AGENT_QUEUE) throw new Error("The background queue is not configured");
 await env.AGENT_QUEUE.send({ kind: "import.mbox", jobId: id });
}
export async function createMboxJob(env: CloudflareEnv, user: SessionUser, mailboxId: string, objectKey: string) {
 await checkAccess(env, user, mailboxId);
 if (!env.AGENT_QUEUE) throw new Error("The background queue is not configured");
 if (!objectKey.startsWith(PRIVATE_PREFIX) || !/\.m(?:box|bx)$/i.test(objectKey) || objectKey.length > 1024 || /[\x00-\x1f]/.test(objectKey) || objectKey.split('/').some(part => part === '..')) throw new Error("Use a .mbox object inside the private mbox-imports/ prefix");
 const object = await env.BUCKET.head(objectKey);
 if (!object || !object.size || !object.etag) throw new Error("MBOX object not found. Finish its multipart upload before starting the import.");
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
    const stagedId = `msg_mbox_${id}_${job.byte_offset}`;
    const staged = await env.DB.prepare("SELECT raw_r2_key FROM messages WHERE id=? AND status='importing'").bind(stagedId).first<{ raw_r2_key: string | null }>();
    if (staged) await deleteMessageWithObjects(env, getDb(env), stagedId, staged.raw_r2_key);
    await env.DB.prepare("UPDATE mbox_import_jobs SET byte_offset=?,processed=processed+1,skipped=skipped+1,status='paused',error=NULL,blocked_next_offset=NULL,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=? AND byte_offset=?")
     .bind(job.blocked_next_offset, Date.now(), id, skipLease, job.byte_offset).run();
   } catch (error) {
    await env.DB.prepare("UPDATE mbox_import_jobs SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?").bind(id, skipLease).run();
    throw error;
   }
  } else {
   await env.DB.prepare("UPDATE mbox_import_jobs SET status='pending',lease_token=NULL,lease_until=0,error=NULL,blocked_next_offset=NULL,updated_at=? WHERE id=? AND status<>'completed' AND (lease_token IS NULL OR lease_until<?)")
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

export async function processMboxJob(env: CloudflareEnv, id: string) {
 const lease = newId("lease"), now = Date.now();
 let job = await env.DB.prepare("UPDATE mbox_import_jobs SET status='running',lease_token=?,lease_until=?,error=NULL,blocked_next_offset=NULL,updated_at=? WHERE id=? AND status IN ('pending','running') AND (lease_token IS NULL OR lease_until<?) RETURNING *")
  .bind(lease, now + LEASE_MS, now, id, now).first<MboxJob>();
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
  for await (const record of readMboxRecords(r2MboxSource(env, job), job.byte_offset, { scanLimit: 64 * 1024 * 1024 })) {
   blockedOffset = record.nextOffset;
   const live = await loadJob(env, id);
   if (!live || live.lease_token !== lease) return;
   if (live.status !== "running") break;
   if (!record.raw) throw new Error("A message exceeds the 20 MiB message limit. Nothing was skipped; explicitly skip this message or process it separately.");
   await env.DB.prepare("UPDATE mbox_import_jobs SET lease_until=? WHERE id=? AND lease_token=?").bind(Date.now() + LEASE_MS, id, lease).run();
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
   for (let start = 0; start < labelIds.length; start += 40) {
    const valid = await validLabelIds(getDb(env), job.mailbox_id, labelIds.slice(start, start + 40));
    if (valid.length) await getDb(env).insert(messageLabels).values(valid.map(folderId => ({ messageId: imported.id, folderId }))).onConflictDoNothing();
   }
   // Publish the message and its checkpoint together, after attachments and labels are complete.
   const results = await env.DB.batch([
    env.DB.prepare("UPDATE messages SET status=? WHERE id=? AND status='importing' AND EXISTS(SELECT 1 FROM mbox_import_jobs WHERE id=? AND lease_token=?)")
     .bind(getImportMessagePlacement(placement.destination).status, imported.id, id, lease),
    env.DB.prepare("UPDATE mbox_import_jobs SET byte_offset=?,processed=processed+1,imported=imported+?,skipped=skipped+?,updated_at=?,lease_until=? WHERE id=? AND lease_token=? RETURNING *")
     .bind(record.nextOffset, imported.created ? 1 : 0, imported.created ? 0 : 1, Date.now(), Date.now() + LEASE_MS, id, lease),
   ]);
   const saved = results[1].results[0] as MboxJob | undefined;
   if (!saved) return; job = saved; blockedOffset = null;
   if (++count >= 5 || Date.now() - now >= 15000) break;
  }
  const live = await loadJob(env, id);
  if (!count && live?.status === "running" && job.byte_offset < job.object_size) throw new Error("No complete messages found in this MBOX archive");
  await env.DB.prepare("UPDATE mbox_import_jobs SET status=CASE WHEN byte_offset>=object_size THEN 'completed' WHEN status='paused' THEN 'paused' ELSE 'pending' END,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?").bind(Date.now(), id, lease).run();
 } catch (error) {
  await env.DB.prepare("UPDATE mbox_import_jobs SET status=CASE WHEN status='paused' THEN 'paused' ELSE 'failed' END,error=?,blocked_next_offset=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?")
   .bind(error instanceof Error ? error.message.slice(0, 350) : "MBOX import failed; resume to retry", blockedOffset, Date.now(), id, lease).run();
 }
 const saved = await loadJob(env, id);
 if (saved?.status === "pending") await enqueue(env, id);
}

export async function recoverMboxJobs(env: CloudflareEnv) {
 const due = await env.DB.prepare("SELECT id FROM mbox_import_jobs WHERE status IN ('pending','running') AND (lease_token IS NULL OR lease_until<?) ORDER BY updated_at ASC LIMIT 5").bind(Date.now()).all<{ id: string }>();
 await Promise.allSettled(due.results.map(job => enqueue(env, job.id)));
}
