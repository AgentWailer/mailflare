import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailImportConnections, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { decodeBase64, GmailError, gmailConfiguration, gmailRequest, type GmailConnection } from "./gmail-oauth";
import { importMessageToMailbox } from "./service";
import { ImportMessageError, isInvalidImportMessage } from "./errors";

type Cursor = { phase: "backfill" | "history"; pending: string[]; retryIds?: string[]; loaded?: boolean; pageToken?: string; nextPageToken?: string; nextHistoryId?: string };
export type GmailSentSync = { connection_id: string; user_id: string; mailbox_id: string; enabled: number; history_id: string | null; cursor: string; imported: number; last_synced_at: number | null; error: string | null; failures: number; retry_at: number; lease_token: string | null; lease_until: number; updated_at: number };
type GoogleMessage = { id: string; labelIds?: string[]; sizeEstimate?: number; raw?: string; internalDate?: string; threadId?: string; payload?: { headers?: { name: string; value: string }[] } };
type History = { historyId?: string; nextPageToken?: string; history?: { messagesAdded?: { message: GoogleMessage }[]; labelsAdded?: { message: GoogleMessage; labelIds: string[] }[] }[] };
const LEASE_MS = 5 * 60_000;
const load = (env: CloudflareEnv, id: string) => env.DB.prepare("SELECT * FROM gmail_sent_sync WHERE connection_id=?").bind(id).first<GmailSentSync>();
const stageId = (connectionId: string, sourceId: string) => `gsent_${connectionId}_${sourceId}`;
class PermissionError extends Error {}

export async function gmailSentSyncStatus(env: CloudflareEnv, userId: string) {
 const rows = (await env.DB.prepare("SELECT s.*, (SELECT count(*) FROM gmail_sent_sync_issues i WHERE i.connection_id=s.connection_id) AS issue_count FROM gmail_sent_sync s WHERE user_id=?").bind(userId).all<GmailSentSync & {issue_count:number}>()).results;
 const issues = (await env.DB.prepare("SELECT i.connection_id,i.source_id,i.error,i.created_at FROM gmail_sent_sync_issues i JOIN gmail_sent_sync s ON s.connection_id=i.connection_id WHERE s.user_id=? ORDER BY i.created_at DESC LIMIT 20").bind(userId).all<{connection_id:string;source_id:string;error:string;created_at:number}>()).results;
 return rows.map(row => ({ connectionId: row.connection_id, mailboxId: row.mailbox_id, enabled: !!row.enabled, backfilling: (JSON.parse(row.cursor) as Cursor).phase === "backfill", imported: row.imported, lastSyncedAt: row.last_synced_at, error: row.error, retryAt: row.retry_at, issueCount: row.issue_count, issues: issues.filter(issue => issue.connection_id === row.connection_id).map(issue => ({sourceId:issue.source_id,error:issue.error})) }));
}

async function authorizedUser(env: CloudflareEnv, job: GmailSentSync) {
 const db = getDb(env), [user] = await db.select().from(users).where(eq(users.id, job.user_id)).limit(1);
 if (!user || user.disabled || !(await getMailboxAccessLevel(db, user, job.mailbox_id))?.canManage) throw new PermissionError();
 return user;
}
async function enqueue(env: CloudflareEnv, id: string) { await env.AGENT_QUEUE?.send({kind:"gmail.sent-sync",connectionId:id}); }

export async function controlGmailSentSync(env: CloudflareEnv, user: SessionUser, input: {connectionId:string;mailboxId:string;action:"enable"|"pause"|"retry";sourceId?:string}) {
 const db = getDb(env), [connection] = await db.select({id:gmailImportConnections.id}).from(gmailImportConnections).where(and(eq(gmailImportConnections.id,input.connectionId),eq(gmailImportConnections.userId,user.id))).limit(1);
 if (!connection || !(await getMailboxAccessLevel(db,user,input.mailboxId))?.canManage) throw new Error("Google connection or mailbox permission is unavailable");
 const existing = await load(env,input.connectionId);
 if (existing && existing.mailbox_id !== input.mailboxId) throw new Error("This Google account already synchronizes to a different mailbox");
 if (input.action === "pause") {
  await env.DB.prepare("UPDATE gmail_sent_sync SET enabled=0,lease_token=NULL,lease_until=0,updated_at=? WHERE connection_id=? AND user_id=?").bind(Date.now(),input.connectionId,user.id).run();
 } else {
  if (!gmailConfiguration(env).configured) throw new Error("Configure the Google OAuth client before synchronizing");
  if (input.action === "retry") {
   const issue = input.sourceId && await env.DB.prepare("SELECT source_id FROM gmail_sent_sync_issues WHERE connection_id=? AND source_id=?").bind(input.connectionId,input.sourceId).first();
   if (!existing || !issue) throw new Error("Sync issue not found");
   if (existing.lease_token && existing.lease_until >= Date.now()) throw new Error("A sync batch is running; try again shortly");
   const cursor = JSON.parse(existing.cursor) as Cursor;
   cursor.retryIds = [...new Set([...(cursor.retryIds ?? []),input.sourceId!])];
   const updated = await env.DB.prepare("UPDATE gmail_sent_sync SET cursor=?,enabled=1,error=NULL,retry_at=0,failures=0,updated_at=? WHERE connection_id=? AND user_id=? AND (lease_token IS NULL OR lease_until<?) RETURNING connection_id").bind(JSON.stringify(cursor),Date.now(),input.connectionId,user.id,Date.now()).first();
   if (!updated) throw new Error("A sync batch is running; try again shortly");
  } else {
   await env.DB.prepare("INSERT INTO gmail_sent_sync(connection_id,user_id,mailbox_id,enabled,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(connection_id) DO UPDATE SET enabled=1,error=NULL,failures=0,retry_at=0,updated_at=excluded.updated_at").bind(input.connectionId,user.id,input.mailboxId,Date.now()).run();
  }
  // The durable record survives failed queue dispatch; cron retries independently.
  await enqueue(env,input.connectionId).catch(()=>{});
 }
 return (await gmailSentSyncStatus(env,user.id)).find(row=>row.connectionId===input.connectionId) ?? null;
}

async function renew(env: CloudflareEnv, job: GmailSentSync, lease: string) {
 const held = await env.DB.prepare("UPDATE gmail_sent_sync SET lease_until=? WHERE connection_id=? AND enabled=1 AND lease_token=? RETURNING connection_id").bind(Date.now()+LEASE_MS,job.connection_id,lease).first();
 if (!held) throw new PermissionError();
}
async function saveCursor(env: CloudflareEnv, job: GmailSentSync, lease: string, cursor: Cursor) {
 const saved = await env.DB.prepare("UPDATE gmail_sent_sync SET cursor=?,history_id=?,lease_until=?,updated_at=? WHERE connection_id=? AND enabled=1 AND lease_token=? RETURNING connection_id").bind(JSON.stringify(cursor),job.history_id,Date.now()+LEASE_MS,Date.now(),job.connection_id,lease).first();
 if (!saved) throw new PermissionError();
}
async function loadPage(env: CloudflareEnv, job: GmailSentSync, connection: GmailConnection, cursor: Cursor) {
 if (!job.history_id) {
  // Anchor BEFORE listing sent mail: sends during the initial scan appear in history.
  const profile = await gmailRequest<{historyId?:string}>(env,connection,"/profile");
  if (!profile.historyId || !/^\d+$/.test(profile.historyId)) throw new Error("Missing Gmail history ID");
  job.history_id = profile.historyId;
 }
 if (cursor.phase === "backfill") {
  const params = new URLSearchParams({labelIds:"SENT",maxResults:"20",includeSpamTrash:"false"});
  if (cursor.pageToken) params.set("pageToken",cursor.pageToken);
  const page = await gmailRequest<{messages?:{id:string}[];nextPageToken?:string}>(env,connection,`/messages?${params}`);
  cursor.pending = [...new Set((page.messages ?? []).map(message=>message.id))];cursor.nextPageToken=page.nextPageToken;
 } else {
  const params = new URLSearchParams({startHistoryId:job.history_id,labelId:"SENT",maxResults:"20"});
  params.append("historyTypes","messageAdded");params.append("historyTypes","labelAdded");
  if (cursor.pageToken) params.set("pageToken",cursor.pageToken);
  let page: History;
  try { page = await gmailRequest<History>(env,connection,`/history?${params}`); }
  catch (error) {
   if (!(error instanceof GmailError) || error.status !== 404) throw error;
   // Google expires old history IDs. A sent-only rescan repairs gaps; deduplication
   // keeps existing local mail and deleted/archived state intact.
   job.history_id=null;Object.assign(cursor,{phase:"backfill",pending:[],loaded:false,pageToken:undefined,nextPageToken:undefined,nextHistoryId:undefined});
   return loadPage(env,job,connection,cursor);
  }
  if (!page.historyId || !/^\d+$/.test(page.historyId)) throw new Error("Missing Gmail history ID");
  cursor.pending=[...new Set((page.history ?? []).flatMap(history=>[
   ...(history.messagesAdded ?? []).filter(event=>!event.message.labelIds || event.message.labelIds.includes("SENT")).map(event=>event.message.id),
   ...(history.labelsAdded ?? []).filter(event=>event.labelIds.includes("SENT")).map(event=>event.message.id),
  ]))];
  cursor.nextPageToken=page.nextPageToken;cursor.nextHistoryId=page.historyId;
 }
 cursor.loaded=true;
}
function isSent(message: GoogleMessage) { return !!message.labelIds?.includes("SENT") && !message.labelIds.some(label=>["TRASH","SPAM","DRAFT"].includes(label)); }
async function copySentMessage(env: CloudflareEnv, job: GmailSentSync, connection: GmailConnection, lease: string, sourceId: string) {
 const params = new URLSearchParams({format:"metadata",fields:"id,labelIds,sizeEstimate,payload/headers",metadataHeaders:"Message-ID"});
 const metadata = await gmailRequest<GoogleMessage>(env,connection,`/messages/${encodeURIComponent(sourceId)}?${params}`);
 if (!isSent(metadata)) return {created:false};
 const sourceKey=`gmail:${connection.email}:${sourceId}`;
 const messageId=metadata.payload?.headers?.find(header=>header.name.toLowerCase()==="message-id")?.value.trim() || sourceKey;
 const existing = await env.DB.prepare("SELECT id,status FROM messages WHERE mailbox_id=? AND provider_message_id IN (?,?) LIMIT 1").bind(job.mailbox_id,messageId,sourceKey).first<{id:string;status:string}>();
 if (existing && existing.status !== "importing") return {created:false};
 if ((metadata.sizeEstimate ?? 0) > 40*1024*1024) throw new ImportMessageError("message_too_large");
 const remote = await gmailRequest<GoogleMessage>(env,connection,`/messages/${encodeURIComponent(sourceId)}?format=raw`);
 if (!isSent(remote)) return {created:false};
 if (!remote.raw || remote.raw.length>56*1024*1024) throw new ImportMessageError("invalid_message_or_size");
 let raw: ArrayBuffer;
 try { raw=decodeBase64(remote.raw).buffer; } catch { throw new ImportMessageError("invalid_message_encoding"); }
 remote.raw=undefined;
 if (raw.byteLength>40*1024*1024) throw new ImportMessageError("message_too_large");
 await authorizedUser(env,job);await renew(env,job,lease);
 const date=Number(remote.internalDate);
 return importMessageToMailbox(env,{userId:job.user_id,mailboxId:job.mailbox_id,filename:sourceId,raw,
  stagingId:stageId(job.connection_id,sourceId),keepStaged:true,destination:{type:"system",section:"sent"},
  metadata:{direction:"outbound",category:"primary",read:true,starred:!!remote.labelIds?.includes("STARRED"),sourceKey,
   ...(Number.isFinite(date)&&date>0?{date:new Date(date)}:{}),
   ...(remote.threadId?{threadId:`gmail:${connection.email}:${remote.threadId}`}:{})}});
}

/** One small server-side batch; no browser session or open page is needed. */
export async function processGmailSentSync(env: CloudflareEnv, connectionId: string) {
 const now=Date.now(),lease=newId("gslease");
 const job=await env.DB.prepare(`UPDATE gmail_sent_sync SET lease_token=?,lease_until=? WHERE connection_id=? AND enabled=1 AND retry_at<=? AND (lease_token IS NULL OR lease_until<?)
 AND NOT EXISTS(SELECT 1 FROM gmail_import_jobs j WHERE j.connection_id=gmail_sent_sync.connection_id AND j.mailbox_id=gmail_sent_sync.mailbox_id AND j.lease_token IS NOT NULL AND j.lease_until>=?) RETURNING *`).bind(lease,now+LEASE_MS,connectionId,now,now,now).first<GmailSentSync>();
 if (!job) return;
 let again=false,touchedSourceId:string|null=null;
 try {
  await authorizedUser(env,job);
  const [connection]=await getDb(env).select().from(gmailImportConnections).where(and(eq(gmailImportConnections.id,connectionId),eq(gmailImportConnections.userId,job.user_id))).limit(1);
  if (!connection) throw new PermissionError();
  const cursor=JSON.parse(job.cursor) as Cursor;
  if (!cursor.loaded && !cursor.pending.length && !cursor.retryIds?.length) { await loadPage(env,job,connection,cursor);await saveCursor(env,job,lease,cursor); }
  for(let step=0;(cursor.pending.length || cursor.retryIds?.length) && step<3 && Date.now()-now<20_000;step++) {
   await renew(env,job,lease);
   const retry=!!cursor.retryIds?.length,sourceId=retry?cursor.retryIds![0]:cursor.pending[0];let created=false,issue:string|null=null;
   touchedSourceId=sourceId;
   try { created=(await copySentMessage(env,job,connection,lease,sourceId)).created;await authorizedUser(env,job); }
   catch(error) {
    if (error instanceof GmailError && error.status===404) { /* Already deleted at Google. */ }
    else if (isInvalidImportMessage(error)) issue=error instanceof ImportMessageError && /^[a-z_]+$/.test(error.message)?error.message:"invalid_message";
    else throw error;
   }
   if (retry) cursor.retryIds!.shift();else cursor.pending.shift();
   const held="EXISTS(SELECT 1 FROM gmail_sent_sync WHERE connection_id=? AND enabled=1 AND lease_token=?)";
   const statements=[env.DB.prepare(`UPDATE messages SET status='sent' WHERE id=? AND status='importing' AND ${held}`).bind(stageId(connectionId,sourceId),connectionId,lease)];
   statements.push(issue
    ? env.DB.prepare(`INSERT INTO gmail_sent_sync_issues(connection_id,source_id,error,created_at) SELECT ?,?,?,? WHERE ${held} ON CONFLICT(connection_id,source_id) DO UPDATE SET error=excluded.error`).bind(connectionId,sourceId,issue,Date.now(),connectionId,lease)
    : env.DB.prepare(`DELETE FROM gmail_sent_sync_issues WHERE connection_id=? AND source_id=? AND ${held}`).bind(connectionId,sourceId,connectionId,lease));
   statements.push(env.DB.prepare("UPDATE gmail_sent_sync SET cursor=?,imported=imported+?,error=NULL,failures=0,lease_until=?,updated_at=? WHERE connection_id=? AND enabled=1 AND lease_token=? RETURNING connection_id").bind(JSON.stringify(cursor),created?1:0,Date.now()+LEASE_MS,Date.now(),connectionId,lease));
   const result=await env.DB.batch(statements);
   if (!result.at(-1)?.results.length) throw new PermissionError();
   job.failures=0;
  }
  if (cursor.loaded && !cursor.pending.length && !cursor.retryIds?.length) {
   if (cursor.nextPageToken) cursor.pageToken=cursor.nextPageToken;
   else if (cursor.phase==="backfill") {cursor.phase="history";cursor.pageToken=undefined;}
   else {job.history_id=cursor.nextHistoryId ?? job.history_id;cursor.pageToken=undefined;}
   again=!!cursor.nextPageToken || cursor.phase==="history" && !cursor.nextHistoryId;
   cursor.loaded=false;cursor.nextPageToken=undefined;cursor.nextHistoryId=undefined;
  } else again=true;
  await saveCursor(env,job,lease,cursor);
  await env.DB.prepare("UPDATE gmail_sent_sync SET error=NULL,failures=0,retry_at=?,last_synced_at=CASE WHEN ?=0 THEN ? ELSE last_synced_at END,lease_token=NULL,lease_until=0,updated_at=? WHERE connection_id=? AND enabled=1 AND lease_token=?").bind(again?0:Date.now()+5*60_000,again?1:0,Date.now(),Date.now(),connectionId,lease).run();
 } catch(error) {
  const permission=error instanceof PermissionError,authorization=error instanceof GmailError && !error.retryable && [400,401,403].includes(error.status) || error instanceof Error && /Reconnect Google/.test(error.message);
  const failures=job.failures+1;
  await env.DB.prepare("UPDATE gmail_sent_sync SET enabled=CASE WHEN ?=1 THEN 0 ELSE enabled END,error=?,failures=?,retry_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE connection_id=? AND lease_token=?").bind(permission||authorization?1:0,permission?"permission_changed":authorization?"google_authorization":"temporary_failure",failures,Date.now()+Math.min(60*60_000,60_000*2**Math.min(failures-1,6)),Date.now(),connectionId,lease).run();
  // A pause/disconnect while fetching must never publish an incomplete staged copy.
  const current=await load(env,connectionId);
  if (!current?.enabled && touchedSourceId) {
   const staged=await env.DB.prepare("SELECT id,raw_r2_key FROM messages WHERE id=? AND status='importing'").bind(stageId(connectionId,touchedSourceId)).first<{id:string;raw_r2_key:string|null}>();
   if(staged) await deleteMessageWithObjects(env,getDb(env),staged.id,staged.raw_r2_key);
  }
  return;
 }
 if (again) await enqueue(env,connectionId).catch(()=>{});
}

export async function recoverGmailSentSync(env: CloudflareEnv) {
 const now=Date.now();
 const rows=(await env.DB.prepare("SELECT connection_id FROM gmail_sent_sync WHERE enabled=1 AND retry_at<=? AND (lease_token IS NULL OR lease_until<?) ORDER BY retry_at,updated_at LIMIT 20").bind(now,now).all<{connection_id:string}>()).results;
 for(const row of rows) {
  if(env.AGENT_QUEUE) await enqueue(env,row.connection_id);
  else await processGmailSentSync(env,row.connection_id);
 }
}
