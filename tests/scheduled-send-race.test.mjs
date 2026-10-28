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
 '@/lib/email/attachments':'export const loadMessageAttachmentContents=(...args)=>globalThis.scheduledProbe.attachments(...args);export const storeMessageAttachments=async()=>{};export const validateAttachments=()=>{};export const normalizeAttachmentContent=x=>x;',
 '@/lib/email/webhooks':'export const dispatchWebhooks=async()=>{};',
 '@/lib/mailboxes/audit':'export const createAuditLog=async()=>{};',
};
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {getDb} from './src/db';export {processOutboundQueue} from './src/lib/email/send';export {cancelScheduledSend} from './src/lib/email/scheduled';`,resolveDir:root},outfile:join(dir,'entry.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts','next/headers':'next/headers.js','next/server':'next/server.js'},plugins:[{name:'no-external-delivery',setup(b){b.onResolve({filter:/^@\/lib\/(email\/(outbound-provider|attachments|webhooks)|mailboxes\/audit)$/},args=>({path:args.path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js'}));}}],logLevel:'silent'});
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
 globalThis.scheduledProbe={attachments:async()=>[],send:async()=>{sends++;return {messageId:'test-id'};}};
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
