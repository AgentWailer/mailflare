import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','scheduled-race-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
const mocks={
 '@/lib/email/outbound-provider':'export const getOutboundProviderConfig=async()=>({provider:"resend"});export const sendThroughProvider=(...args)=>globalThis.scheduledProbe.send(...args);',
 '@/lib/email/attachments':'export const loadMessageAttachmentContents=(...args)=>globalThis.scheduledProbe.attachments(...args);export const storeMessageAttachments=(...args)=>globalThis.scheduledProbe.store?.(...args)??Promise.resolve([]);export const cleanupUnpublishedAttachments=(...args)=>globalThis.scheduledProbe.cleanup?.(...args)??Promise.resolve();export const validateAttachments=()=>{};export const normalizeAttachmentContent=x=>x;',
 '@/lib/email/webhooks':'export const dispatchWebhooks=(...args)=>globalThis.scheduledProbe.webhooks(...args);',
 '@/lib/mailboxes/audit':'export const createAuditLog=(...args)=>globalThis.scheduledProbe.audit(...args);',
};
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {messages} from './src/db/schema';export {getDb} from './src/db';export {processOutboundQueue,recoverOutboundJobs,sendEmail} from './src/lib/email/send';export {cancelScheduledSend,getScheduledDeliveryState,scheduledMessageCondition,publicDeliveryError} from './src/lib/email/scheduled';`,resolveDir:root},outfile:join(dir,'entry.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts','next/headers':'next/headers.js','next/server':'next/server.js'},plugins:[{name:'no-external-delivery',setup(b){b.onResolve({filter:/^@\/lib\/(email\/(outbound-provider|attachments|webhooks)|mailboxes\/audit)$/},args=>({path:args.path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js'}));}}],logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'entry.mjs')).href);
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,future=false){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,join(root,'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','x','Owner',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,created_at) VALUES('domain','owner','example.test','z',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('box','owner','domain','owner',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at) VALUES('mail','owner','box','outbound','owner@example.test','test@example.test','queued',1);`);
 const input={userId:'owner',from:'owner@example.test',to:'test@example.test',subject:'Synthetic test only',text:'Test',mailboxId:'box'};
 const scheduledAt=new Date(Date.now()+(future?60000:-1000));
 DB.db.prepare(`INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES('job','owner','mail','queued',?,?,1,1)`).run(JSON.stringify(input),Math.floor(scheduledAt.getTime()/1000));
 let sends=0;const queued=[];
 globalThis.scheduledProbe={attachments:async()=>[],audit:async()=>{},webhooks:async()=>{},send:async()=>{sends++;return {messageId:'test-id'};}};
 const env={DB,OUTBOUND_QUEUE:{send:async(...args)=>queued.push(args)}},db=app.getDb(env);
 return {DB,env,db,queued,sends:()=>sends,payload:{kind:'email.scheduled',jobId:'job',messageId:'mail',scheduledAt:scheduledAt.toISOString()},status:()=>DB.db.prepare("SELECT status FROM messages WHERE id='mail'").get().status};
}
test('cancel during attachment loading wins and no provider is called',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();globalThis.scheduledProbe.attachments=async()=>{entered.resolve();await release.promise;return [];};
 const run=app.processOutboundQueue(f.env,f.payload);await entered.promise;
 assert.equal(await app.cancelScheduledSend(f.db,'mail'),true);release.resolve();await run;
 assert.equal(f.sends(),0);assert.equal(f.status(),'draft');
});
test('after delivery claims the job cancellation fails and duplicate consumers do not send again',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();const send=globalThis.scheduledProbe.send;
 globalThis.scheduledProbe.send=async(...args)=>{entered.resolve();await release.promise;return send(...args);};
 const run=app.processOutboundQueue(f.env,f.payload);await entered.promise;
 assert.equal(await app.cancelScheduledSend(f.db,'mail'),false);
 await app.processOutboundQueue(f.env,f.payload);release.resolve();await run;
 assert.equal(f.sends(),1);assert.equal(f.status(),'sent');
});
test('failed attachment loading leaves the job retryable before any delivery',async t=>{
 const f=await fixture(t);globalThis.scheduledProbe.attachments=async()=>{throw Error('Synthetic storage outage');};
 await assert.rejects(app.processOutboundQueue(f.env,f.payload),/storage outage/);assert.equal(f.sends(),0);
 assert.equal(f.DB.db.prepare("SELECT status FROM outbound_jobs WHERE id='job'").get().status,'queued');
 globalThis.scheduledProbe.attachments=async()=>[];await app.processOutboundQueue(f.env,f.payload);
 assert.equal(f.sends(),1);assert.equal(f.status(),'sent');
});
test('future sends remain queued and cancellable',async t=>{
 const f=await fixture(t,true);await app.processOutboundQueue(f.env,f.payload);
 assert.equal(f.queued.length,1);assert.equal(f.sends(),0);assert.equal(await app.cancelScheduledSend(f.db,'mail'),true);
});

test('a database failure rolls back both cancellation changes',async t=>{
 const f=await fixture(t);
 f.DB.db.exec("CREATE TRIGGER stop_cancel BEFORE DELETE ON outbound_jobs BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END;");
 await assert.rejects(app.cancelScheduledSend(f.db,'mail'));
 assert.equal(f.status(),'queued');
 assert.equal(f.DB.db.prepare("SELECT status FROM outbound_jobs WHERE id='job'").get().status,'queued');
});


test('confirmed send survives audit/webhook failure and recovery never calls the provider again',async t=>{
 const f=await fixture(t);let audits=0,hooks=0;
 globalThis.scheduledProbe.audit=async()=>{audits++;throw Error('Synthetic audit failure');};
 globalThis.scheduledProbe.webhooks=async()=>{hooks++;throw Error('Synthetic webhook query failure');};
 await app.processOutboundQueue(f.env,f.payload);
 assert.equal(f.sends(),1);assert.equal(f.status(),'sent');
 let job=f.DB.db.prepare("SELECT status,error FROM outbound_jobs WHERE id='job'").get();
 assert.deepEqual(job,{status:'sent',error:'post_send_pending:audit,webhook'});
 globalThis.scheduledProbe.audit=async()=>{audits++;};globalThis.scheduledProbe.webhooks=async()=>{hooks++;};
 await app.recoverOutboundJobs(f.env,new Date(Date.now()+6*60000));
 job=f.DB.db.prepare("SELECT status,error FROM outbound_jobs WHERE id='job'").get();
 assert.deepEqual(job,{status:'sent',error:null});assert.equal(f.sends(),1);assert.equal(audits,2);assert.equal(hooks,2);
});

test('a saved provider receipt repairs interrupted sent-state persistence without re-delivery',async t=>{
 const f=await fixture(t);
 f.DB.db.exec("CREATE TRIGGER stop_sent BEFORE UPDATE OF status ON messages WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'Synthetic database failure'); END;");
 await assert.rejects(app.processOutboundQueue(f.env,f.payload),error=>error.code==='delivery_status_pending'&&/Delivery was accepted/.test(error.message));
 assert.equal(f.sends(),1);assert.equal(f.status(),'queued');
 const job=f.DB.db.prepare("SELECT status,error FROM outbound_jobs WHERE id='job'").get();
 assert.equal(job.status,'unknown');assert.deepEqual(JSON.parse(job.error),{accepted:'test-id'});
 f.DB.db.exec('DROP TRIGGER stop_sent');await app.recoverOutboundJobs(f.env,new Date(Date.now()+6*60000));
 assert.equal(f.sends(),1);assert.equal(f.status(),'sent');
 assert.equal(f.DB.db.prepare("SELECT status FROM outbound_jobs WHERE id='job'").get().status,'sent');
});

test('provider timeout and stale sending claims are quarantined and are never blindly retried',async t=>{
 const f=await fixture(t);let attempts=0;
 globalThis.scheduledProbe.send=async()=>{attempts++;throw Error('Timeout after sending bytes');};
 await assert.rejects(app.processOutboundQueue(f.env,f.payload),error=>error.code==='delivery_unknown'&&/outcome is unknown/.test(error.message));
 assert.equal(f.DB.db.prepare("SELECT status FROM outbound_jobs WHERE id='job'").get().status,'unknown');
 await app.processOutboundQueue(f.env,f.payload);await app.recoverOutboundJobs(f.env,new Date(Date.now()+20*60000));
 assert.equal(attempts,1);assert.equal(f.queued.length,0);assert.equal(await app.cancelScheduledSend(f.db,'mail'),false);
 f.DB.db.exec("UPDATE outbound_jobs SET status='sending',error=NULL,updated_at=1 WHERE id='job'");
 await app.recoverOutboundJobs(f.env);
 const visible=await app.getScheduledDeliveryState(f.db,'mail');assert.equal(visible.deliveryStatus,'unknown');assert.equal(visible.deliveryError,'delivery_unknown');
 assert.equal(attempts,1);assert.equal(f.queued.length,0);
});

test('a lost initial queue handoff is accepted durably and recovered at most once per recovery interval',async t=>{
 const f=await fixture(t);const queue=f.env.OUTBOUND_QUEUE.send;
 f.env.OUTBOUND_QUEUE.send=async()=>{throw Error('Queue unavailable');};
 const result=await app.sendEmail(f.env,{userId:'owner',mailboxId:'box',from:'owner@example.test',to:'recipient@example.test',subject:'Synthetic scheduled test',text:'Test',scheduledAt:new Date(Date.now()+60000)});
 assert.equal(result.scheduled,true);assert.equal(f.sends(),0);
 const row=f.DB.db.prepare('SELECT id,status,error FROM outbound_jobs WHERE message_id=?').get(result.messageId);assert.equal(row.status,'queued');assert.equal(row.error,'queue_pending');
 // Remove the fixture's unrelated original job to isolate the newly queued send.
 f.DB.db.exec("DELETE FROM outbound_jobs WHERE id='job'");f.env.OUTBOUND_QUEUE.send=queue;
 const now=new Date(Date.now()+10*60000);await app.recoverOutboundJobs(f.env,now);await app.recoverOutboundJobs(f.env,now);
 assert.equal(f.queued.length,1);assert.equal(f.queued[0][0].messageId,result.messageId);assert.equal(f.sends(),0);
});

test('pre-send attachment failures stop after three attempts and remain safely editable',async t=>{
 const f=await fixture(t);globalThis.scheduledProbe.attachments=async()=>{throw Error('Storage temporarily unavailable');};
 for(let i=0;i<3;i++)await assert.rejects(app.processOutboundQueue(f.env,f.payload));
 assert.equal(f.sends(),0);assert.equal((await app.getScheduledDeliveryState(f.db,'mail')).deliveryStatus,'failed');
 await app.processOutboundQueue(f.env,f.payload);await app.recoverOutboundJobs(f.env,new Date(Date.now()+20*60000));assert.equal(f.queued.length,0);
 assert.equal(await app.cancelScheduledSend(f.db,'mail'),true);assert.equal(f.status(),'draft');
});

test('missing attachments fail before sending, and forged queue message IDs cannot redirect a job',async t=>{
 const f=await fixture(t);globalThis.scheduledProbe.attachments=async()=>{const e=Error('Missing file');e.name='MissingAttachmentError';throw e;};
 await app.processOutboundQueue(f.env,{...f.payload,messageId:'foreign'});assert.equal(f.sends(),0);
 await assert.rejects(app.processOutboundQueue(f.env,f.payload));
 const visible=await app.getScheduledDeliveryState(f.db,'mail');assert.equal(visible.deliveryStatus,'failed');assert.equal(visible.deliveryError,'attachment_missing');assert.equal(f.sends(),0);
});

test('recovery selects only eligible bounded metadata, not old sent payload bodies',async t=>{
 const f=await fixture(t);
 const insert=f.DB.db.prepare("INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES(?,'owner','mail',?,?,1,1,1)");
 for(let i=0;i<60;i++)insert.run('done-'+i,'sent','DO NOT LOAD PRIVATE BODY');
 for(let i=0;i<30;i++)insert.run('pending-'+i,'queued','DO NOT LOAD PRIVATE BODY');
 const queries=[],prepare=f.DB.prepare.bind(f.DB);f.DB.prepare=sql=>{queries.push(sql);return prepare(sql);};
 await app.recoverOutboundJobs(f.env);assert.equal(f.queued.length,20);assert.equal(f.sends(),0);
 assert(queries.filter(sql=>sql.startsWith('select')).every(sql=>!sql.includes('"payload"')&&!sql.includes('"html_body"')));
});


test('problem deliveries remain discoverable in Scheduled without exposing raw provider errors',async t=>{
 const f=await fixture(t);
 for(const state of ['queued','sending','failed','unknown']){
  f.DB.db.prepare("UPDATE outbound_jobs SET status=?,error=? WHERE id='job'").run(state,'Private provider response with credentials');
  const rows=await f.db.select({id:app.messages.id}).from(app.messages).where(app.scheduledMessageCondition(f.db));
  assert.deepEqual(rows.map(row=>row.id),['mail']);
  const detail=await app.getScheduledDeliveryState(f.db,'mail');assert.equal(detail.deliveryStatus,state);assert.equal(detail.deliveryError,null);
 }
 f.DB.db.exec("UPDATE outbound_jobs SET status='sent' WHERE id='job'");
 assert.equal((await f.db.select({id:app.messages.id}).from(app.messages).where(app.scheduledMessageCondition(f.db))).length,0);
 assert.equal(app.publicDeliveryError(JSON.stringify({accepted:'private-provider-id'})),'delivery_accepted_unrecorded');
});


test('outbox insert failure cannot leave a queued message without a recoverable job',async t=>{
 const f=await fixture(t),cleaned=[];
 const file={id:'new-file',filename:'staged.pdf',type:'application/pdf',size:3,disposition:'attachment',contentId:null,r2Key:'staged-key'};
 globalThis.scheduledProbe.store=async()=>[file];globalThis.scheduledProbe.cleanup=async(_env,files)=>cleaned.push(...files);
 f.DB.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbound_jobs BEGIN SELECT RAISE(ABORT,'Synthetic outbox insert failure'); END;");
 await assert.rejects(app.sendEmail(f.env,{userId:'owner',mailboxId:'box',from:'owner@example.test',to:'recipient@example.test',subject:'Atomic publication test',text:'Test',attachments:[{filename:'staged.pdf',type:'application/pdf',content:new TextEncoder().encode('pdf').buffer}],scheduledAt:new Date(Date.now()+60000)}));
 assert.equal(f.sends(),0);assert.equal(f.queued.length,0);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM outbound_jobs').get().n,1);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,0);assert.deepEqual(cleaned,[file]);
});

test('lost successful outbox publication response is reconciled before returning accepted schedule',async t=>{
 const f=await fixture(t),batch=f.DB.batch.bind(f.DB);let intercepted=false;
 f.DB.batch=async statements=>{const results=await batch(statements);if(!intercepted&&f.DB.db.prepare('SELECT count(*) n FROM outbound_jobs').get().n===2){intercepted=true;throw Error('Synthetic lost publication response');}return results;};
 const result=await app.sendEmail(f.env,{userId:'owner',mailboxId:'box',from:'owner@example.test',to:'recipient@example.test',subject:'Lost response test',text:'Test',scheduledAt:new Date(Date.now()+60000)});
 assert.equal(result.scheduled,true);assert.equal(f.sends(),0);assert.equal(f.queued.length,1);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM outbound_jobs WHERE message_id=?').get(result.messageId).n,1);
});

test('lost successful receipt response preserves sent state and never resends',async t=>{
 const f=await fixture(t),batch=f.DB.batch.bind(f.DB);let intercepted=false;
 f.DB.batch=async statements=>{const results=await batch(statements);if(!intercepted&&f.DB.db.prepare("SELECT status FROM outbound_jobs WHERE id='job'").get().status==='sent'){intercepted=true;throw Error('Synthetic lost receipt response');}return results;};
 await app.processOutboundQueue(f.env,f.payload);
 assert.equal(f.status(),'sent');assert.equal(f.DB.db.prepare("SELECT status FROM outbound_jobs WHERE id='job'").get().status,'sent');
 await app.processOutboundQueue(f.env,f.payload);await app.recoverOutboundJobs(f.env,new Date(Date.now()+20*60000));
 assert.equal(f.sends(),1);assert.equal(f.queued.length,0);
});
