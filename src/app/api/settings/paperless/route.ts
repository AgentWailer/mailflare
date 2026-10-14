import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { readJsonBody } from "@/lib/http/request";
import { newId } from "@/lib/ids";
import { decryptCredentials,encryptCredentials,normalizePaperlessUrl,PaperlessError,testPaperlessConnection,type PaperlessCredentials } from "@/lib/paperless/client";
import { loadConnection,recoverPaperlessJobs } from "@/lib/paperless/jobs";
const headers={"Cache-Control":"private, no-store"};
const common=z.object({mailboxId:z.string().min(1).max(128)});
const schema=z.discriminatedUnion("action",[
 common.extend({action:z.literal("save"),baseUrl:z.string().max(2048),token:z.string().trim().max(1024).optional(),accessId:z.string().trim().max(1024).optional(),accessSecret:z.string().trim().max(2048).optional(),enabled:z.boolean(),labelId:z.string().max(128).nullable(),processedLabelId:z.string().max(128).nullable()}).strict(),
 common.extend({action:z.enum(["retry","cancel"]),jobId:z.string().min(1).max(256),confirmUncertain:z.boolean().optional()}).strict(),
]);
export async function GET(request: Request) {
 const env=getEnv(),auth=await requireSessionUser(env,request);if(auth.error)return auth.error;
 const mailboxId=new URL(request.url).searchParams.get("mailboxId");
 if (!mailboxId || !(await getMailboxAccessLevel(getDb(env),auth.user,mailboxId))?.canManage) return NextResponse.json({error:"Mailbox not found"},{status:404,headers});
 const c=await loadConnection(env,mailboxId);
 const [labels,jobs,counts]=await Promise.all([
  env.DB.prepare("SELECT id,name,parent_id parentId FROM folders WHERE mailbox_id=? ORDER BY name").bind(mailboxId).all(),
  env.DB.prepare(`SELECT j.id,j.base_url baseUrl,j.message_id messageId,j.status,j.error,j.document_id documentId,j.task_id taskId,a.filename,m.subject,j.updated_at updatedAt FROM paperless_jobs j JOIN messages m ON m.id=j.message_id JOIN message_attachments a ON a.id=j.attachment_id WHERE j.mailbox_id=? ORDER BY CASE WHEN j.status IN ('failed','uncertain','paused') THEN 0 ELSE 1 END,j.updated_at DESC LIMIT 30`).bind(mailboxId).all(),
  env.DB.prepare("SELECT status,count(*) count FROM paperless_jobs WHERE mailbox_id=? GROUP BY status").bind(mailboxId).all(),
 ]);
 return NextResponse.json({available:!!env.PAPERLESS_ENCRYPTION_KEY&&!!env.AGENT_QUEUE,connection:c?{baseUrl:c.base_url,enabled:!!c.enabled,labelId:c.label_id,processedLabelId:c.processed_label_id,hasToken:!!c.credentials}:null,labels:labels.results,jobs:jobs.results,counts:counts.results},{headers});
}
export async function POST(request: Request) {
 const env=getEnv(),auth=await requireSessionUser(env,request);if(auth.error)return auth.error;
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({error:"Invalid origin"},{status:403,headers});
 const parsed=schema.safeParse(await readJsonBody(request,8192).catch(()=>null));
 if (!parsed.success) return NextResponse.json({error:"invalid_settings"},{status:400,headers});
 const input=parsed.data;
 if (!(await getMailboxAccessLevel(getDb(env),auth.user,input.mailboxId))?.canManage) return NextResponse.json({error:"Mailbox not found"},{status:404,headers});
 try {
  if (input.action !== "save") {
   const job=await env.DB.prepare("SELECT status,task_id,error FROM paperless_jobs WHERE id=? AND mailbox_id=?").bind(input.jobId,input.mailboxId).first<{status:string;task_id:string|null;error:string|null}>();
   if (!job) return NextResponse.json({error:"Job not found"},{status:404,headers});
   if(input.action==="cancel") {
    await env.DB.prepare("UPDATE paperless_jobs SET status='cancelled',error='cancelled_by_user',updated_at=? WHERE id=? AND mailbox_id=? AND status IN ('pending','waiting','failed','uncertain','paused') AND lease_until<?").bind(Date.now(),input.jobId,input.mailboxId,Date.now()).run();
   } else {
    if ((job.status==="uncertain" || (job.error==="restore_requires_review" && !job.task_id)) && !input.confirmUncertain) return NextResponse.json({error:"confirm_uncertain"},{status:409,headers});
    // A known task is polled again. It is never blindly uploaded a second time.
    await env.DB.prepare("UPDATE paperless_jobs SET status=CASE WHEN task_id IS NULL THEN 'pending' ELSE 'waiting' END,error=NULL,attempts=0,retry_at=0,user_id=?,updated_at=? WHERE id=? AND mailbox_id=? AND status IN ('failed','uncertain','paused') AND lease_until<?").bind(auth.user.id,Date.now(),input.jobId,input.mailboxId,Date.now()).run();
   }
   await recoverPaperlessJobs(env);return NextResponse.json({ok:true},{headers});
  }
  if (!env.AGENT_QUEUE || !env.PAPERLESS_ENCRYPTION_KEY) throw new PaperlessError("encryption_unavailable");
  const old=await loadConnection(env,input.mailboxId),baseUrl=normalizePaperlessUrl(input.baseUrl);
  if (old && old.base_url!==baseUrl && await env.DB.prepare("SELECT id FROM paperless_jobs WHERE mailbox_id=? AND status NOT IN ('completed','cancelled') LIMIT 1").bind(input.mailboxId).first()) throw new PaperlessError("destination_has_jobs");
  let credentials:PaperlessCredentials;
  if (input.token) {
   credentials={token:input.token};
   if (input.accessId || input.accessSecret) {
    if (!input.accessId || !input.accessSecret) throw new PaperlessError("access_credentials_required");
    credentials.accessId=input.accessId;credentials.accessSecret=input.accessSecret;
   } else if (old?.base_url===baseUrl && old.credentials) {
    const stored=await decryptCredentials(env,input.mailboxId,baseUrl,old.credentials);
    credentials.accessId=stored.accessId;credentials.accessSecret=stored.accessSecret;
   }
  } else {
   if (!old || old.base_url!==baseUrl) throw new PaperlessError("token_required");
   credentials=await decryptCredentials(env,input.mailboxId,baseUrl,old.credentials);
   if (input.accessId || input.accessSecret) {
    if (!input.accessId || !input.accessSecret) throw new PaperlessError("access_credentials_required");
    credentials.accessId=input.accessId;credentials.accessSecret=input.accessSecret;
   }
  }
  if (/[\r\n]/.test(credentials.token+(credentials.accessId??"")+(credentials.accessSecret??""))) throw new PaperlessError("invalid_settings");
  // Disabling an unchanged connection always works even if the remote server is offline.
  if (input.enabled || !old || input.token || old.base_url!==baseUrl) await testPaperlessConnection(baseUrl,credentials);
  const encrypted=await encryptCredentials(env,input.mailboxId,baseUrl,credentials);
  const statements:D1PreparedStatement[]=[];
  async function label(id:string|null,name:string,parent:string|null):Promise<string> {
   if (id) {
    if (!await env.DB.prepare("SELECT id FROM folders WHERE id=? AND mailbox_id=?").bind(id,input.mailboxId).first()) throw new PaperlessError("invalid_label");
    return id;
   }
   const found=await env.DB.prepare("SELECT id FROM folders WHERE name=? AND mailbox_id=?").bind(name,input.mailboxId).first<{id:string}>();
   if(found)return found.id;
   const created=newId("fld");
   statements.push(env.DB.prepare("INSERT INTO folders(id,user_id,mailbox_id,name,parent_id,created_at) VALUES(?,?,?,?,?,?)").bind(created,auth.user!.id,input.mailboxId,name,parent,Math.floor(Date.now()/1000)));
   return created;
  }
  const labelId=await label(input.labelId,"Paperless",null),processedId=await label(input.processedLabelId,"Verarbeitet",labelId);
  if (labelId===processedId) throw new PaperlessError("invalid_label");
  statements.push(env.DB.prepare(`INSERT INTO paperless_connections(mailbox_id,user_id,base_url,credentials,enabled,label_id,processed_label_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
   ON CONFLICT(mailbox_id) DO UPDATE SET user_id=excluded.user_id,base_url=excluded.base_url,credentials=excluded.credentials,enabled=excluded.enabled,label_id=excluded.label_id,processed_label_id=excluded.processed_label_id,updated_at=excluded.updated_at`)
   .bind(input.mailboxId,auth.user.id,baseUrl,encrypted,Number(input.enabled),labelId,processedId,Date.now(),Date.now()));
  if(input.enabled) statements.push(env.DB.prepare("UPDATE paperless_jobs SET status=CASE WHEN task_id IS NULL THEN 'pending' ELSE 'waiting' END,error=NULL,retry_at=0 WHERE mailbox_id=? AND status='paused' AND error='connection_disabled' AND base_url=?").bind(input.mailboxId,baseUrl));
  await env.DB.batch(statements);
  await recoverPaperlessJobs(env).catch(()=>{});
  return NextResponse.json({ok:true},{headers});
 } catch(error) { return NextResponse.json({error:error instanceof PaperlessError?error.code:"settings_failed"},{status:400,headers}); }
}
