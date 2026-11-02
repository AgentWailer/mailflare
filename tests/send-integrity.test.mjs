import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd(), dir=mkdtempSync(join(root,'node_modules','send-integrity-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
const send=join(dir,'send.ts');writeFileSync(send,'export const sendEmail=(_env,payload)=>globalThis.__integritySend(payload);');
const auth=join(dir,'auth.ts');writeFileSync(auth,'export const requireUser=async()=>globalThis.__integrityUser; export const getCurrentUser=requireUser; export const resolveCurrentUser=async()=>({user:globalThis.__integrityUser});');
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';
 export {requestAgentSend,confirmAgentSend} from './src/lib/agent/approvals/utils';
 export {editAgentDraft} from './src/lib/agent/edit-draft';export {discardAgentDraft} from './src/lib/agent/draft-mutation';
 export {loadMessageAttachmentContents,copyMessageAttachments,storeMessageAttachments} from './src/lib/email/attachments';
 export {PATCH as patchDraft,DELETE as deleteDraft} from './src/app/api/drafts/[id]/route';
 export {POST as addFiles} from './src/app/api/drafts/[id]/attachments/route';
 export {DELETE as deleteFile} from './src/app/api/drafts/[id]/attachments/[attachmentId]/route';
 export {POST as sendRoute} from './src/app/api/send/route';
 export {DeliveryOutcomeError} from './src/lib/email/send-errors';
 export {POST as driveFiles} from './src/app/api/drive/attachments/route';
`,resolveDir:root},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'@/lib/email/send':send,'@/lib/auth/cookies':auth,'next/server':'next/server.js','next/headers':'next/headers.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,join(root,'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,subject,text_body,created_at) VALUES
 ('draft','owner','box','outbound','owner@example.test','recipient@example.test','draft','Approved','Approved body',1),
 ('source','owner','box','inbound','source@example.test','owner@example.test','received','Source','Source body',1),
 ('forward','owner','box','outbound','owner@example.test','recipient@example.test','draft','Forward','Forward body',1);
 INSERT INTO agent_draft_metadata(draft_id,mailbox_id,origin,revision,created_at) VALUES('draft','box','mcp',1,1);
 INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,r2_key,created_at) VALUES
 ('old-att','draft','approved.pdf','application/pdf',3,'attachment','old-key',1),
 ('source-att','source','unapproved.pdf','application/pdf',3,'attachment','source-key',1);`);
 const bytes=new TextEncoder().encode('pdf').buffer,objects=new Map([['old-key',bytes],['source-key',bytes]]),reads=new Map(),sent=[];
 const f={DB,objects,reads,sent,onRead:async()=>{},onSend:async()=>{}};
 const env={DB,BUCKET:{get:async key=>{const data=objects.get(key);if(!data)return null;return {body:new Response(data).body,arrayBuffer:async()=>{reads.set(key,(reads.get(key)??0)+1);await f.onRead(key);return data.slice(0);}};},put:async(key,value)=>{objects.set(key,value instanceof Blob?await value.arrayBuffer():value instanceof ReadableStream?await new Response(value).arrayBuffer():value);},delete:async key=>objects.delete(key)}};
 const user={id:'owner',role:'user',email:'owner@example.test'};
 globalThis.__integritySend=async payload=>{sent.push(payload);await f.onSend(payload);return {messageId:'test-sent'};};globalThis.__integrityUser=user;globalThis.__mailflareNodeEnv=env;
 t.after(()=>{delete globalThis.__integritySend;delete globalThis.__integrityUser;delete globalThis.__mailflareNodeEnv;});
 return Object.assign(f,{env,user,context:{env,user,mailboxId:'box',origin:'mcp'},params:{params:Promise.resolve({id:'draft',attachmentId:'old-att'})}});
}
const patchRequest=()=>new Request('https://mailflare.test/api/drafts/draft',{method:'PATCH',headers:{Origin:'https://mailflare.test','Content-Type':'application/json'},body:JSON.stringify({mailboxId:'box',from:'owner@example.test',to:'recipient@example.test',subject:'Changed',text:'Changed human body'})});

test('send API exposes stable delivery outcome codes while retaining error text for existing clients',async t=>{
 const f=await fixture(t);
 for(const [code,message] of [
  ['delivery_unknown','Delivery outcome is unknown. Check Sent and the recipient before sending again.'],
  ['delivery_status_pending','Delivery was accepted, but its status could not be saved. Check Sent before sending again.'],
 ]){
  f.onSend=async()=>{throw new app.DeliveryOutcomeError(code,message);};
  const response=await app.sendRoute(new Request('https://mailflare.test/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mailboxId:'box',from:'owner@example.test',to:'recipient@example.test',subject:'Synthetic error contract test',text:'Test'})}));
  assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:message,code});
 }
});

test('concurrent AI attachment/body replacement invalidates old approval, then the newly reviewed exact version sends once',async t=>{
 const f=await fixture(t), approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 f.onRead=async key=>{if(key==='old-key'&&f.reads.get(key)===2)await app.editAgentDraft(f.context,{draftId:'draft',expectedRevision:1,body:'Changed body',removeAttachmentIds:['old-att'],addAttachments:[{sourceEmailId:'source',attachmentId:'source-att'}]});};
 await assert.rejects(app.confirmAgentSend(f.env,f.user,approval.approvalId),/Draft changed/);assert.equal(f.sent.length,0);
 assert.equal(f.DB.db.prepare('SELECT revision FROM agent_draft_metadata').get().revision,2);
 const fresh=await app.requestAgentSend(f.env,f.user,'draft',2);await app.confirmAgentSend(f.env,f.user,fresh.approvalId);
 assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].attachments.map(a=>a.filename),['unapproved.pdf']);assert.equal(f.sent[0].text,'Changed body');
});

test('concurrent human body edit invalidates the approval before the atomic claim',async t=>{
 const f=await fixture(t),approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 f.onRead=async key=>{if(key==='old-key'&&f.reads.get(key)===2)assert.equal((await app.patchDraft(patchRequest(),f.params)).status,200);};
 await assert.rejects(app.confirmAgentSend(f.env,f.user,approval.approvalId),/Draft changed/);assert.equal(f.sent.length,0);assert.equal(f.DB.db.prepare("SELECT text_body FROM messages WHERE id='draft'").get().text_body,'Changed human body');
});

test('a claimed approval locks AI/human body and attachment edits and deletion, and sends only the verified bytes',async t=>{
 const f=await fixture(t),approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 f.onSend=async payload=>{
  assert.equal(f.DB.db.prepare('SELECT status FROM agent_send_approvals').get().status,'claimed');
  await assert.rejects(app.editAgentDraft(f.context,{draftId:'draft',expectedRevision:1,body:'Not approved',addAttachments:[{sourceEmailId:'source',attachmentId:'source-att'}]}),/sending is in progress/);
  assert.equal((await app.patchDraft(patchRequest(),f.params)).status,409);
  const form=new FormData();form.append('attachments',new File(['new'],'new.pdf',{type:'application/pdf'}));
  assert.equal((await app.addFiles(new Request('https://mailflare.test/api/drafts/draft/attachments',{method:'POST',headers:{Origin:'https://mailflare.test'},body:form}),f.params)).status,409);
  assert.equal((await app.deleteFile(new Request('https://mailflare.test/api/drafts/draft/attachments/old-att',{method:'DELETE'}),f.params)).status,409);
  assert.equal((await app.deleteDraft(new Request('https://mailflare.test/api/drafts/draft',{method:'DELETE'}),f.params)).status,409);
  await assert.rejects(app.discardAgentDraft(f.env,'draft',1,null),/sending is in progress/);
  assert.deepEqual([...f.objects.keys()].sort(),['old-key','source-key'],'unpublished staged files are cleaned');
  assert.deepEqual(payload.attachments.map(a=>a.filename),['approved.pdf']);assert.equal(new TextDecoder().decode(payload.attachments[0].content),'pdf');
  assert.equal(f.reads.get('old-key'),2,'review and confirmation each read once; send never reloads mutable attachments');
 };
 await app.confirmAgentSend(f.env,f.user,approval.approvalId);assert.equal(f.sent.length,1);
});

test('two pending reviews cannot both send the same draft',async t=>{
 const f=await fixture(t),a=await app.requestAgentSend(f.env,f.user,'draft',1),b=await app.requestAgentSend(f.env,f.user,'draft',1);
 const results=await Promise.allSettled([app.confirmAgentSend(f.env,f.user,a.approvalId),app.confirmAgentSend(f.env,f.user,b.approvalId)]);
 assert.equal(f.sent.length,1);assert(results.some(r=>r.status==='fulfilled'));assert.equal(f.DB.db.prepare("SELECT count(*) n FROM agent_send_approvals WHERE status='sent'").get().n,1);
});

test('missing files stop send and forwarding, preserve draft/source and clean only partial new copies',async t=>{
 const f=await fixture(t);f.objects.delete('old-key');
 await assert.rejects(app.loadMessageAttachmentContents(f.env,'draft'),/Attachment unavailable: approved.pdf/);
 await assert.rejects(app.copyMessageAttachments(f.env,'draft','forward'),/Attachment unavailable/);
 f.DB.db.exec("DELETE FROM agent_draft_metadata WHERE draft_id='draft'");
 const response=await app.sendRoute(new Request('https://mailflare.test/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mailboxId:'box',draftId:'draft',from:'owner@example.test',to:'recipient@example.test',subject:'Approved',text:'Approved body'})}));
 assert.equal(response.status,409);const error=await response.json();assert.match(error.error,/approved.pdf/);assert.equal(error.code,'attachment_unavailable');assert.equal(error.filename,'approved.pdf');assert.equal(f.sent.length,0);assert.equal(f.DB.db.prepare("SELECT status FROM messages WHERE id='draft'").get().status,'draft');
 f.DB.db.exec("INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,r2_key,created_at) VALUES('missing','source','missing.pdf','application/pdf',3,'attachment','missing-key',1)");
 await assert.rejects(app.copyMessageAttachments(f.env,'source','forward'),/missing.pdf/);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM message_attachments WHERE message_id='forward'").get().n,0);assert.deepEqual([...f.objects.keys()],['source-key']);
});

test('failed upload publication rolls back both newly created rows and objects',async t=>{
 const f=await fixture(t);f.DB.db.exec("CREATE TRIGGER reject_bad_file BEFORE INSERT ON message_attachments WHEN NEW.filename='bad.pdf' BEGIN SELECT RAISE(FAIL,'synthetic failure'); END");
 await assert.rejects(app.storeMessageAttachments(f.env,'forward',[{filename:'good.pdf',type:'application/pdf',content:new TextEncoder().encode('pdf').buffer},{filename:'bad.pdf',type:'application/pdf',content:new TextEncoder().encode('pdf').buffer}]),error=>error.cause?.message==='synthetic failure');
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM message_attachments WHERE message_id='forward'").get().n,0);assert.deepEqual([...f.objects.keys()].sort(),['old-key','source-key']);
});

test('atomic mutation rolls back membership and revision when final publication fails',async t=>{
 const f=await fixture(t);f.DB.db.exec("CREATE TRIGGER reject_revision BEFORE UPDATE ON agent_draft_metadata BEGIN SELECT RAISE(FAIL,'synthetic revision failure'); END");
 await assert.rejects(app.editAgentDraft(f.context,{draftId:'draft',expectedRevision:1,body:'Changed',removeAttachmentIds:['old-att'],addAttachments:[{sourceEmailId:'source',attachmentId:'source-att'}]}),/synthetic revision failure/);
 assert.equal(f.DB.db.prepare('SELECT revision FROM agent_draft_metadata').get().revision,1);assert.equal(f.DB.db.prepare("SELECT text_body FROM messages WHERE id='draft'").get().text_body,'Approved body');
 assert.deepEqual(f.DB.db.prepare("SELECT id FROM message_attachments WHERE message_id='draft'").all(),[{id:'old-att'}]);assert.deepEqual([...f.objects.keys()].sort(),['old-key','source-key']);
});


test('restored missing attachment can be retried without any earlier provider call',async t=>{
 const f=await fixture(t),approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 f.objects.delete('old-key');await assert.rejects(app.confirmAgentSend(f.env,f.user,approval.approvalId),/Attachment unavailable/);
 assert.equal(f.sent.length,0);assert.equal(f.DB.db.prepare('SELECT status FROM agent_send_approvals').get().status,'pending');
 f.objects.set('old-key',new TextEncoder().encode('pdf').buffer);await app.confirmAgentSend(f.env,f.user,approval.approvalId);
 assert.equal(f.sent.length,1);await app.confirmAgentSend(f.env,f.user,approval.approvalId);assert.equal(f.sent.length,1);
});

test('changed stored bytes require renewed review; ambiguous send keeps the draft locked',async t=>{
 const f=await fixture(t),approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 f.objects.set('old-key',new TextEncoder().encode('new').buffer);await assert.rejects(app.confirmAgentSend(f.env,f.user,approval.approvalId),/Draft changed/);assert.equal(f.sent.length,0);
 f.objects.set('old-key',new TextEncoder().encode('pdf').buffer);f.onSend=async()=>{throw new Error('synthetic transport uncertainty');};
 await assert.rejects(app.confirmAgentSend(f.env,f.user,approval.approvalId),/Delivery outcome needs review/);
 assert.equal(f.DB.db.prepare('SELECT status FROM agent_send_approvals').get().status,'unknown');
 await assert.rejects(app.editAgentDraft(f.context,{draftId:'draft',expectedRevision:1,body:'After send'}),/sending is in progress/);
 await app.confirmAgentSend(f.env,f.user,approval.approvalId);assert.equal(f.sent.length,1,'ambiguous transport outcome is never automatically resent');
});


test('a lost successful batch response never cleans up files that the draft already published',async t=>{
 const f=await fixture(t),batch=f.DB.batch.bind(f.DB);
 f.DB.batch=async statements=>{await batch(statements);throw new Error('synthetic lost response after commit');};
 await assert.rejects(app.editAgentDraft(f.context,{draftId:'draft',expectedRevision:1,body:'Changed',removeAttachmentIds:['old-att'],addAttachments:[{sourceEmailId:'source',attachmentId:'source-att'}]}),/lost response/);
 const file=f.DB.db.prepare("SELECT r2_key FROM message_attachments WHERE message_id='draft'").get();
 assert(file);assert(f.objects.has(file.r2_key),'committed attachment bytes remain available');
 assert.equal(f.DB.db.prepare('SELECT revision FROM agent_draft_metadata').get().revision,2);
 assert.equal(f.DB.db.prepare("SELECT text_body FROM messages WHERE id='draft'").get().text_body,'Changed');
});


test('expired stale approval cannot overwrite an approval already claimed by another request',async t=>{
 const f=await fixture(t),approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 f.DB.db.exec("UPDATE agent_send_approvals SET expires_at=1");
 const prepare=f.DB.prepare.bind(f.DB);let injected=false;
 f.DB.prepare=sql=>{
  const stmt=prepare(sql),bind=stmt.bind.bind(stmt);
  stmt.bind=(...params)=>{const bound=bind(...params),raw=bound.raw.bind(bound);bound.raw=async(...args)=>{
   const rows=await raw(...args);
   if(!injected&&sql.startsWith('select')&&sql.includes('from "agent_send_approvals"')){injected=true;f.DB.db.exec("UPDATE agent_send_approvals SET status='claimed'");}
   return rows;
  };return bound;};return stmt;
 };
 await assert.rejects(app.confirmAgentSend(f.env,f.user,approval.approvalId),/expired/);
 assert.equal(f.DB.db.prepare('SELECT status FROM agent_send_approvals').get().status,'claimed');assert.equal(f.sent.length,0);
});

test('confirmed send remains sent when only draft cleanup fails, and repeated confirmation never resends',async t=>{
 const f=await fixture(t),approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 f.DB.db.exec("CREATE TRIGGER fail_cleanup BEFORE UPDATE OF status ON messages WHEN NEW.status='trash' BEGIN SELECT RAISE(ABORT,'Synthetic cleanup failure'); END;");
 const sent=await app.confirmAgentSend(f.env,f.user,approval.approvalId);
 assert.equal(sent.status,'sent');assert.equal(f.DB.db.prepare('SELECT status FROM agent_send_approvals').get().status,'sent');
 await app.confirmAgentSend(f.env,f.user,approval.approvalId);assert.equal(f.sent.length,1);
 assert.equal(f.DB.db.prepare("SELECT status FROM messages WHERE id='draft'").get().status,'draft');
});

test('Drive attachment changes revise AI drafts and cannot mutate a claimed send',async t=>{
 const f=await fixture(t),approval=await app.requestAgentSend(f.env,f.user,'draft',1);
 const action=action=>app.driveFiles(new Request('https://mailflare.test/api/drive/attachments',{method:'POST',headers:{Origin:'https://mailflare.test','Content-Type':'application/json'},body:JSON.stringify({action,ids:['old-att']})}));
 assert.equal((await action('trash')).status,200);assert.equal(f.DB.db.prepare('SELECT revision FROM agent_draft_metadata').get().revision,2);
 assert.equal((await action('restore')).status,200);assert.equal(f.DB.db.prepare('SELECT revision FROM agent_draft_metadata').get().revision,3);
 await assert.rejects(app.confirmAgentSend(f.env,f.user,approval.approvalId),/Draft changed/);
 const fresh=await app.requestAgentSend(f.env,f.user,'draft',3);
 f.onSend=async()=>{const blocked=await action('trash');assert.equal(blocked.status,409);assert.equal((await blocked.json()).code,'draft_changed');};
 await app.confirmAgentSend(f.env,f.user,fresh.approvalId);assert.equal(f.sent.length,1);assert.equal(f.DB.db.prepare("SELECT trashed_at FROM message_attachments WHERE id='old-att'").get().trashed_at,null);assert(f.objects.has('old-key'));
});
