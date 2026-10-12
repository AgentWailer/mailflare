import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mbox-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>globalThis.__mboxCookie?{value:globalThis.__mboxCookie}:undefined}}');
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database.ts';export {applyMigrations} from './server/runtime/migrate.ts';export {getDb} from './src/db/index.ts';export {users} from './src/db/schema/index.ts';export {createSession} from './src/lib/auth/session.ts';export {readMboxRecords} from './src/lib/import/mbox-stream.ts';export {mboxPlacement} from './src/lib/import/mbox-labels.ts';export * from './src/lib/import/mbox-jobs.ts';export {importMessageToMailbox} from './src/lib/import/service.ts';export {GET as list,POST as create} from './src/app/api/import/mbox/jobs/route.ts';export {POST as control} from './src/app/api/import/mbox/jobs/[id]/route.ts';export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';export {parseImportForm} from './src/app/api/import/messages/utils.ts';export {importMessageFiles} from './src/components/settings/import-messages-utils.ts';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const envelope='From sender@example.test Wed Jan 01 12:00:00 2025\r\n';
function mail(id,labels='Inbox,Unread,Work,Clients/Project',attachment=false){return envelope+`From: Sender <sender@example.test>\r\nTo: Owner <owner@example.test>\r\nMessage-ID: <${id}@example.test>\r\nDate: Wed, 01 Jan 2025 12:00:00 +0000\r\nSubject: Mail ${id}\r\nX-Gmail-Labels: ${labels}\r\n`+(attachment?'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=test\r\n\r\n--test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHallo!\r\n--test\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="test.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--test--\r\n':'Content-Type: text/plain; charset=utf-8\r\n\r\nHallo Grüße\r\n>From a quoted body sentence\r\n>>From another quotation\r\nFrom an ordinary body sentence\r\n');}
async function fixture(t,content=Array.from({length:13},(_,i)=>mail(i)).join('')){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,'drizzle/migrations');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('admin','admin@example.test','hash','Admin','admin',1),('owner','owner@example.test','hash','Owner','user',1);INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','manual','active',1);INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','admin','domain','owner','personal',1),('foreign','owner','domain','other','personal',1);`);
 const objects=new Map([['mbox-imports/archive.mbox',new TextEncoder().encode(content)]]),calls=[],queue=[];let etag='original',failure=false,hook=null;
 const BUCKET={head:async key=>{const bytes=objects.get(key);return bytes?{key,size:bytes.length,etag:key==='mbox-imports/archive.mbox'?etag:'item'}:null;},get:async(key,opts)=>{calls.push({key,...opts?.range});if(failure)throw Error('Temporary R2 failure');const bytes=objects.get(key);if(!bytes)return null;const data=opts?.range?bytes.slice(opts.range.offset,opts.range.offset+opts.range.length):bytes;return {etag:key==='mbox-imports/archive.mbox'?etag:'item',size:bytes.length,body:new Blob([data]).stream(),arrayBuffer:async()=>data.slice().buffer};},put:async(key,raw)=>{if(hook)await hook(key);objects.set(key,new Uint8Array(raw));},delete:async key=>objects.delete(key)};
 const env={DB,BUCKET,MAILFLARE_RUNTIME:'node',AGENT_QUEUE:{send:async value=>queue.push(value)}};globalThis.__mailflareNodeEnv=env;
 const user=(await app.getDb(env).select().from(app.users)).find(x=>x.id==='admin'),tokens={admin:await app.createSession(env,'admin'),owner:await app.createSession(env,'owner')};
 const request=(body,who='admin')=>new Request('https://mailflare.test/api/import/mbox/jobs?mailboxId=box',{method:body?'POST':'GET',headers:{Authorization:'Bearer '+(tokens[who]??'no-token'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return {DB,env,user,objects,calls,queue,request,etag:value=>etag=value,fail:value=>failure=value,hook:value=>hook=value};
}
async function allRecords(file,offset=0,options={}){const records=[];for await(const record of app.readMboxRecords(file,offset,options))records.push(record);return records;}
async function drain(f,id){for(let i=0;i<20;i++){await app.processMboxJob(f.env,id);const job=f.DB.db.prepare('SELECT * FROM mbox_import_jobs WHERE id=?').get(id);if(job.status!=='pending')return job;}throw Error('Import did not terminate');}

test('chunked MBOX parsing preserves bytes, quoted From lines, CRLF and resume boundaries',async()=>{
 const raw=Buffer.concat([Buffer.from(mail(1)),Buffer.from(mail(2).replace('Hallo Grüße','x'.repeat(4000)))]),file=new Blob([raw]);
 const records=await allRecords(file,0,{chunkSize:1024});assert.equal(records.length,2);assert.equal(records[0].nextOffset,Buffer.byteLength(mail(1)));assert.equal(records[1].nextOffset,file.size);
 const first=await records[0].raw.text();assert(first.includes('Hallo Grüße\r\nFrom a quoted'));assert(first.includes('\r\n>From another'));assert(first.includes('\r\nFrom an ordinary'));
 const resumed=await allRecords(file,records[0].nextOffset,{chunkSize:1024});assert.equal(resumed.length,1);assert.deepEqual(Buffer.from(await resumed[0].raw.arrayBuffer()),Buffer.from(await records[1].raw.arrayBuffer()));
 await assert.rejects(allRecords(new Blob(['not a mailbox'])));await assert.rejects(allRecords(file,-1));
});
test('resuming beyond 10 GiB uses bounded slices and never rereads the whole archive',async()=>{
 const offset=10*1024**3,tail=new TextEncoder().encode(mail('large')),reads=[];
 const source={size:offset+tail.length,slice(start,end){reads.push({start,end});assert(start>=offset);assert(end-start<=2*1024**2);return {arrayBuffer:async()=>tail.slice(start-offset,end-offset).buffer};}};
 const records=await allRecords(source,offset);assert.equal(records.length,1);assert.equal(records[0].nextOffset,source.size);assert((await records[0].raw.text()).includes('Mail large'));assert.equal(reads.length,1);
});
test('oversized messages release memory, keep the next boundary and are never silently imported',async()=>{
 const raw=mail('oversized').replace('Hallo Grüße','x'.repeat(10000))+mail('next'),records=await allRecords(new Blob([raw]),0,{chunkSize:1024,maxMessageSize:1500});assert.equal(records.length,2);assert.equal(records[0].raw,null);assert(records[1].raw);assert.equal(records[0].nextOffset,Buffer.byteLength(raw)-Buffer.byteLength(mail('next')));
});
test('Gmail export placement retains spam, trash, sent, drafts, read, stars and multiple labels',()=>{
 for(const [labels,status,direction,category,read] of [['Spam,Unread','spam','inbound','primary',false],['Trash','trash','inbound','primary',true],['Sent,Starred','sent','outbound','primary',true],['Draft','drafts','outbound','primary',true],['Inbox,Unread,Category Promotions','inbox','inbound','promotions',false],['Inbox,Category Social','inbox','inbound','social',true]]){const p=app.mboxPlacement(new TextEncoder().encode(mail('flags',labels)).buffer);assert.equal(p.destination.section,status);assert.equal(p.metadata.direction,direction);assert.equal(p.metadata.category,category);assert.equal(p.metadata.read,read);}
 assert.deepEqual(app.mboxPlacement(new TextEncoder().encode(mail('labels','Inbox,Work,Clients/Project')).buffer).labels,['Work','Clients/Project']);
 const ordinary=app.mboxPlacement(new TextEncoder().encode(mail('plain').replace(/^X-Gmail-Labels:.*\r\n/m,'')).buffer);assert.equal(ordinary.destination.section,'archived');assert.equal(ordinary.metadata.read,true);
});
test('queue batches finish all 113 messages, preserve attachments and labels, and do not reclassify or notify',async t=>{
 const f=await fixture(t,Array.from({length:113},(_,i)=>mail(i,i===1?'Spam,Unread':i===2?'Trash':i===3?'Sent,Starred':'Inbox,Unread,Work,Clients/Project',i===0)).join(''));
 f.env.AI={run:async()=>{throw Error('Must not classify archive mail');}};f.env.REALTIME={getByName:()=>{throw Error('Must not notify archive mail');}};
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');assert.equal(f.queue[0].kind,'import.mbox');await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT processed FROM mbox_import_jobs').get().processed,5);
 for(let i=0;i<30;i++)await app.processMboxJob(f.env,job.id);
 const saved=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(saved.status,'completed');assert.equal(saved.imported,113);assert.equal(saved.processed,113);assert.equal(saved.byte_offset,saved.object_size);
 const rows=f.DB.db.prepare('SELECT * FROM messages').all();assert.equal(rows.length,113);assert.equal(rows.find(x=>x.subject==='Mail 1').status,'spam');assert.equal(rows.find(x=>x.subject==='Mail 2').status,'trash');assert.equal(rows.find(x=>x.subject==='Mail 3').status,'sent');assert.equal(rows.find(x=>x.subject==='Mail 3').starred,1);assert.equal(rows[0].created_at,1735732800);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,220);assert(f.objects.has('mbox-imports/archive.mbox'));assert(f.calls.filter(x=>x.key==='mbox-imports/archive.mbox').every(x=>x.length<=2*1024**2));
});
test('pause persists through queue delivery; failed reads resume from the last acknowledged message',async t=>{
 const f=await fixture(t),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 const checkpoint=f.DB.db.prepare('SELECT byte_offset FROM mbox_import_jobs').get().byte_offset;
 await app.controlMboxJob(f.env,f.user,job.id,'pause');await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT processed FROM mbox_import_jobs').get().processed,5);
 await app.controlMboxJob(f.env,f.user,job.id,'resume');f.fail(true);await app.processMboxJob(f.env,job.id);const failed=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(failed.status,'failed');assert.equal(failed.byte_offset,checkpoint);assert.equal(failed.blocked_next_offset,null);
 f.fail(false);await app.controlMboxJob(f.env,f.user,job.id,'resume');const completed=await drain(f,job.id);assert.equal(completed.imported,13);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,13);
});
test('duplicate queues cannot race a leased job; changed sources and revoked permission stop before writing',async t=>{
 const f=await fixture(t),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 f.DB.db.prepare("UPDATE mbox_import_jobs SET status='running',lease_token='other',lease_until=?").run(Date.now()+60000);await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT processed FROM mbox_import_jobs').get().processed,5);
 f.DB.db.exec("UPDATE mbox_import_jobs SET lease_until=0");f.etag('changed');await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT status FROM mbox_import_jobs').get().status,'failed');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,5);
 f.etag('original');await app.controlMboxJob(f.env,f.user,job.id,'resume');f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='admin'");await app.processMboxJob(f.env,job.id);assert.match(f.DB.db.prepare('SELECT error FROM mbox_import_jobs').get().error,/disabled/);
});
test('message failures pause before advancing; explicit skip handles only that message',async t=>{
 const f=await fixture(t,mail(1)+mail(2)+mail(3));let fail=true;f.hook(async()=>{if(fail)throw Error('Attachment storage failed');});
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);let row=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(row.status,'failed');assert.equal(row.processed,0);assert.equal(row.byte_offset,0);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 await app.controlMboxJob(f.env,f.user,job.id,'skip');fail=false;await app.controlMboxJob(f.env,f.user,job.id,'resume');row=await drain(f,job.id);assert.equal(row.processed,3);assert.equal(row.skipped,1);assert.equal(row.imported,2);assert(!f.DB.db.prepare("SELECT id FROM messages WHERE subject='Mail 1'").get());
});
test('interrupted hidden imports are rebuilt safely; completed messages are deduplicated on checkpoint replay',async t=>{
 const f=await fixture(t,mail(1,'Inbox,Unread',true));const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');
 const id=`msg_mbox_${job.id}_0`;f.DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,provider_message_id,status,raw_r2_key,created_at) VALUES(?,'admin','box','inbound','sender@example.test','owner@example.test','<1@example.test>','importing',?,1)").run(id,`imports/${id}.eml`);
 let row=await drain(f,job.id);assert.equal(row.status,'completed');assert.equal(f.DB.db.prepare('SELECT status FROM messages').get().status,'received');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,1);
 f.DB.db.exec("UPDATE mbox_import_jobs SET status='pending',byte_offset=0,processed=0,imported=0,skipped=0");row=await drain(f,job.id);assert.equal(row.imported,0);assert.equal(row.skipped,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,1);
});
test('a label failure keeps the entire message hidden; skipping removes partial objects and rows',async t=>{
 const f=await fixture(t,mail(1,'Inbox,Unread,Work',true)+mail(2));
 f.DB.db.exec("CREATE TRIGGER reject_import_label BEFORE INSERT ON folders BEGIN SELECT RAISE(ABORT,'Label write failed'); END;");
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 assert.equal(f.DB.db.prepare('SELECT status FROM mbox_import_jobs').get().status,'failed');assert.equal(f.DB.db.prepare('SELECT status FROM messages').get().status,'importing');
 await app.controlMboxJob(f.env,f.user,job.id,'skip');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,0);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,0);
 assert.deepEqual([...f.objects.keys()],['mbox-imports/archive.mbox']);f.DB.db.exec('DROP TRIGGER reject_import_label');await app.controlMboxJob(f.env,f.user,job.id,'resume');const done=await drain(f,job.id);assert.equal(done.imported,1);assert.equal(done.skipped,1);
});
test('messages without Message-ID stay distinct and label limits do not silently discard data',async t=>{
 const content=[1,2,3].map(id=>mail(id).replace(/^Message-ID:.*\r\n/m,'')).join('');const f=await fixture(t,content);const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');const done=await drain(f,job.id);assert.equal(done.imported,3);assert.equal(f.DB.db.prepare('SELECT count(DISTINCT provider_message_id) n FROM messages').get().n,3);
 const labels=app.mboxPlacement(new TextEncoder().encode(mail('labels','Inbox,constructor,=\?UTF-8\?B\?UHLDvGZ1bmc=\?=')).buffer).labels;assert.deepEqual(labels,['constructor','Prüfung']);
 assert.throws(()=>app.mboxPlacement(new TextEncoder().encode(mail('many',Array.from({length:101},(_,i)=>'label'+i).join(','))).buffer),/100/);
});
test('R2 range adapter rejects changed ETags, partial reads and storage ignoring ranges',async()=>{
 const job={object_key:'mbox-imports/one.mbox',object_etag:'original',object_size:10};
 for(const [etag,bytes] of [['changed',4],['original',3],['original',5]]){const env={BUCKET:{get:async()=>({etag,size:10,body:new Blob([new Uint8Array(bytes)]).stream()})}};await assert.rejects(app.r2MboxSource(env,job).slice(0,4).arrayBuffer());}
});
test('admin session, origin, private prefix and mailbox checks guard all import endpoints',async t=>{
 const f=await fixture(t);assert.equal((await app.list(f.request(undefined,'anon'))).status,401);assert.equal((await app.list(f.request(undefined,'owner'))).status,403);assert.equal((await app.create(f.request({mailboxId:'box',objectKey:'imports/one.eml'}))).status,400);
 globalThis.__mboxCookie=f.request().headers.get('Authorization').slice(7);assert.equal((await app.create(new Request('https://mailflare.test/api/import/mbox/jobs',{method:'POST',headers:{Origin:'https://attacker.test','Content-Type':'application/json'},body:JSON.stringify({mailboxId:'box',objectKey:'mbox-imports/archive.mbox'})}))).status,403);delete globalThis.__mboxCookie;
 assert.equal((await app.create(f.request({mailboxId:'missing',objectKey:'mbox-imports/archive.mbox'}))).status,400);
 const first=await(await app.create(f.request({mailboxId:'box',objectKey:'mbox-imports/archive.mbox'}))).json(),second=await(await app.create(f.request({mailboxId:'box',objectKey:'mbox-imports/archive.mbox'}))).json();assert.equal(first.job.id,second.job.id);
 const response=await app.list(f.request());assert.equal(response.headers.get('Cache-Control'),'private, no-store');const text=await response.text();assert(!text.includes('lease_token'));assert(!text.includes('object_etag'));
 f.DB.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='box'");assert.equal((await app.list(f.request())).status,400);
});
test('backup includes jobs once, restores active jobs paused, and older pre-migration backups remain restorable',async t=>{
 const f=await fixture(t),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 const bytes=await app.exportDatabaseRecords(f.env.DB),doc=JSON.parse(new TextDecoder().decode(bytes));assert.equal(doc.tables.mbox_import_jobs.length,1);await app.restoreDatabaseRecords(f.env.DB,bytes.buffer);assert.equal(f.DB.db.prepare('SELECT status FROM mbox_import_jobs').get().status,'paused');
 delete doc.tables.mbox_import_jobs;doc.includedTables=doc.includedTables.filter(x=>x!=='mbox_import_jobs');await app.restoreDatabaseRecords(f.env.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mbox_import_jobs').get().n,0);
 const prior=join(dir,'pre-mbox');mkdirSync(prior);for(const name of readdirSync('drizzle/migrations').filter(x=>x.endsWith('.sql')&&!x.startsWith('0067_')))writeFileSync(join(prior,name),readFileSync(join('drizzle/migrations',name)));
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,prior);const old=await app.exportDatabaseRecords(DB);await app.restoreDatabaseRecords(DB,old.buffer);await app.applyMigrations(DB,'drizzle/migrations');await app.restoreDatabaseRecords(DB,old.buffer);
});
test('small-upload parser rejects excess messages instead of truncating an MBOX',async()=>{
 const form=new FormData();form.set('mailboxId','box');form.set('destination','system:inbox');form.set('files',new File([Array.from({length:101},(_,i)=>mail(i)).join('')],'small.mbox',{type:'application/mbox'}));await assert.rejects(app.parseImportForm(new Request('https://mailflare.test/api/import/messages',{method:'POST',body:form})),/100/);
});

test('a 10 GB browser file is rejected before any upload starts',async()=>{
 await assert.rejects(app.importMessageFiles('box',[{size:10*1024**3,name:'archive.mbox'}],'system:inbox'),/background MBOX import/);
});
