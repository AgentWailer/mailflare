import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mbox-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>globalThis.__mboxCookie?{value:globalThis.__mboxCookie}:undefined}}');
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database.ts';export {applyMigrations} from './server/runtime/migrate.ts';export {getDb} from './src/db/index.ts';export {users} from './src/db/schema/index.ts';export {createSession} from './src/lib/auth/session.ts';export {readMboxRecords} from './src/lib/import/mbox-stream.ts';export {mboxPlacement} from './src/lib/import/mbox-labels.ts';export * from './src/lib/import/mbox-jobs.ts';export * from './src/lib/import/mbox-issues.ts';export {GET as issuesGet,POST as issuesPost} from './src/app/api/import/mbox/jobs/[id]/issues/route.ts';export * from './src/lib/import/mbox-sorting.ts';export {POST as sortingControl} from './src/app/api/import/mbox/jobs/[id]/sorting/route.ts';export {classifyIncomingMail} from './src/lib/mail-sorting/classifier.ts';export {importMessageToMailbox} from './src/lib/import/service.ts';export {GET as list,POST as create} from './src/app/api/import/mbox/jobs/route.ts';export {POST as control} from './src/app/api/import/mbox/jobs/[id]/route.ts';export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';export {parseImportForm} from './src/app/api/import/messages/utils.ts';export {importMessageFiles} from './src/components/settings/import-messages-utils.ts';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
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
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');assert.equal(f.queue[0].kind,'import.mbox');await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT processed FROM mbox_import_jobs').get().processed,25);
 for(let i=0;i<30;i++)await app.processMboxJob(f.env,job.id);
 const saved=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(saved.status,'completed');assert.equal(saved.imported,113);assert.equal(saved.processed,113);assert.equal(saved.byte_offset,saved.object_size);
 const rows=f.DB.db.prepare('SELECT * FROM messages').all();assert.equal(rows.length,113);assert.equal(rows.find(x=>x.subject==='Mail 1').status,'spam');assert.equal(rows.find(x=>x.subject==='Mail 2').status,'trash');assert.equal(rows.find(x=>x.subject==='Mail 3').status,'sent');assert.equal(rows.find(x=>x.subject==='Mail 3').starred,1);assert.equal(rows[0].created_at,1735732800);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,220);assert(f.objects.has('mbox-imports/archive.mbox'));assert(f.calls.filter(x=>x.key==='mbox-imports/archive.mbox').every(x=>x.length<=2*1024**2));
});
test('pause persists through queue delivery; failed reads resume from the last acknowledged message',async t=>{
 const f=await fixture(t,Array.from({length:63},(_,i)=>mail(i)).join('')),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 const checkpoint=f.DB.db.prepare('SELECT byte_offset FROM mbox_import_jobs').get().byte_offset;
 await app.controlMboxJob(f.env,f.user,job.id,'pause');await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT processed FROM mbox_import_jobs').get().processed,25);
 await app.controlMboxJob(f.env,f.user,job.id,'resume');f.fail(true);await app.processMboxJob(f.env,job.id);const failed=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(failed.status,'pending');assert(failed.retry_at>Date.now());assert.equal(failed.byte_offset,checkpoint);assert.equal(failed.blocked_next_offset,null);
 f.fail(false);await app.controlMboxJob(f.env,f.user,job.id,'resume');const completed=await drain(f,job.id);assert.equal(completed.imported,63);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,63);
});
test('duplicate queues cannot race a leased job; changed sources and revoked permission stop before writing',async t=>{
 const f=await fixture(t,Array.from({length:63},(_,i)=>mail(i)).join('')),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 f.DB.db.prepare("UPDATE mbox_import_jobs SET status='running',lease_token='other',lease_until=?").run(Date.now()+60000);await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT processed FROM mbox_import_jobs').get().processed,25);
 f.DB.db.exec("UPDATE mbox_import_jobs SET lease_until=0");f.etag('changed');await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT status FROM mbox_import_jobs').get().status,'failed');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,25);
 f.etag('original');await app.controlMboxJob(f.env,f.user,job.id,'resume');f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='admin'");await app.processMboxJob(f.env,job.id);assert.match(f.DB.db.prepare('SELECT error FROM mbox_import_jobs').get().error,/disabled/);
});
test('unknown infrastructure failures stop safely; explicit skip logs only that message',async t=>{
 const f=await fixture(t,mail(1)+mail(2)+mail(3));let fail=true;f.hook(async()=>{if(fail)throw Error('Invalid storage configuration');});
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
 const f=await fixture(t,Array.from({length:63},(_,i)=>mail(i)).join('')),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 const bytes=await app.exportDatabaseRecords(f.env.DB),doc=JSON.parse(new TextDecoder().decode(bytes));assert.equal(doc.tables.mbox_import_jobs.length,1);await app.restoreDatabaseRecords(f.env.DB,bytes.buffer);assert.equal(f.DB.db.prepare('SELECT status FROM mbox_import_jobs').get().status,'paused');
 delete doc.tables.mbox_import_jobs;doc.includedTables=doc.includedTables.filter(x=>x!=='mbox_import_jobs');await app.restoreDatabaseRecords(f.env.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mbox_import_jobs').get().n,0);
 const prior=join(dir,'pre-mbox');mkdirSync(prior);for(const name of readdirSync('drizzle/migrations').filter(x=>x.endsWith('.sql')&&x<'0067_'))writeFileSync(join(prior,name),readFileSync(join('drizzle/migrations',name)));
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,prior);
 const old=await app.exportDatabaseRecords(DB);await app.restoreDatabaseRecords(DB,old.buffer);await app.applyMigrations(DB,'drizzle/migrations');
 await app.restoreDatabaseRecords(DB,old.buffer);
});
test('small-upload parser rejects excess messages instead of truncating an MBOX',async()=>{
 const form=new FormData();form.set('mailboxId','box');form.set('destination','system:inbox');form.set('files',new File([Array.from({length:101},(_,i)=>mail(i)).join('')],'small.mbox',{type:'application/mbox'}));await assert.rejects(app.parseImportForm(new Request('https://mailflare.test/api/import/messages',{method:'POST',body:form})),/100/);
});

test('a 10 GB browser file is rejected before any upload starts',async()=>{
 await assert.rejects(app.importMessageFiles('box',[{size:10*1024**3,name:'archive.mbox'}],'system:inbox'),/background MBOX import/);
});

test('owned Drive MBOX objects completed through S3 are reconciled and imported without copying',async t=>{
 const f=await fixture(t,mail('drive'));const key='drive/admin/drv_archive',bytes=f.objects.get('mbox-imports/archive.mbox');f.objects.set(key,bytes);
 f.DB.db.prepare("INSERT INTO drive_items(id,owner_id,kind,name,r2_key,size,upload_id,upload_part_size,upload_fingerprint,created_at,updated_at) VALUES('drv_archive','admin','file','Archive.mbox',?,?,'pending',67108864,'fingerprint',1,1)").run(key,bytes.length);
 f.DB.db.exec("INSERT INTO drive_upload_parts(item_id,part_number,etag) VALUES('drv_archive',1,'etag')");
 const job=await app.createMboxJob(f.env,f.user,'box',key);const row=f.DB.db.prepare("SELECT * FROM drive_items WHERE id='drv_archive'").get();assert.equal(row.upload_id,null);assert.equal(row.upload_fingerprint,null);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM drive_upload_parts').get().n,0);
 const done=await drain(f,job.id);assert.equal(done.status,'completed');assert.equal(done.imported,1);assert(f.objects.has(key));assert.equal([...f.objects.keys()].filter(x=>x.startsWith('drive/')).length,1);
});
test('Drive source validation rejects foreign, trashed, non-MBOX, incomplete and mismatched files',async t=>{
 const f=await fixture(t,mail('drive'));const key='drive/admin/drv_archive',bytes=f.objects.get('mbox-imports/archive.mbox');f.objects.set(key,bytes);
 f.DB.db.prepare("INSERT INTO drive_items(id,owner_id,kind,name,r2_key,size,upload_id,created_at,updated_at) VALUES('drv_archive','owner','file','Archive.mbox',?,?,'pending',1,1)").run(key,bytes.length);
 await assert.rejects(app.createMboxJob(f.env,f.user,'box',key),/own Drive/);
 f.DB.db.exec("UPDATE drive_items SET owner_id='admin',trashed_at=1");await assert.rejects(app.createMboxJob(f.env,f.user,'box',key),/own Drive/);
 f.DB.db.exec("UPDATE drive_items SET trashed_at=NULL,name='Other.pdf'");await assert.rejects(app.createMboxJob(f.env,f.user,'box',key),/own Drive/);
 f.DB.db.exec("UPDATE drive_items SET name='Archive.mbox',size=size+1");await assert.rejects(app.createMboxJob(f.env,f.user,'box',key),/declared file size/);
 f.objects.delete(key);await assert.rejects(app.createMboxJob(f.env,f.user,'box',key),/Finish its multipart upload/);
 assert.equal(f.DB.db.prepare('SELECT upload_id FROM drive_items').get().upload_id,'pending');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mbox_import_jobs').get().n,0);
});


test('archive contacts download new avatars and preserve manual names, blocking, avatars and outbound sources',async t=>{
 const f=await fixture(t,mail('manual')+mail('new').replaceAll('sender@example.test','new@example.test')+mail('outbound').replaceAll('sender@example.test','outbound@example.test'));
 f.DB.db.exec("INSERT INTO contacts(id,user_id,email,display_name,source,blocked,avatar_key,last_seen_at,created_at) VALUES('manual','admin','sender@example.test','My chosen name','manual',1,'avatars/existing',1,1),('outbound','admin','outbound@example.test','Old name','outbound',0,NULL,1,1)");
 const originalFetch=globalThis.fetch;let fetches=0;globalThis.fetch=async()=>{fetches++;return new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'image/png'}});};t.after(()=>globalThis.fetch=originalFetch);
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');const done=await drain(f,job.id);assert.equal(done.imported,3);assert.equal(fetches,2);
 const manual=f.DB.db.prepare("SELECT * FROM contacts WHERE id='manual'").get();assert.equal(manual.display_name,'My chosen name');assert.equal(manual.source,'manual');assert.equal(manual.blocked,1);assert.equal(manual.avatar_key,'avatars/existing');assert(manual.last_seen_at>1);
 const outbound=f.DB.db.prepare("SELECT * FROM contacts WHERE id='outbound'").get();assert.equal(outbound.source,'outbound');assert.equal(outbound.display_name,'Sender');
 const fresh=f.DB.db.prepare("SELECT * FROM contacts WHERE email='new@example.test'").get();assert.equal(fresh.display_name,'Sender');assert.equal(fresh.source,'inbound');assert(fresh.avatar_key);assert(f.objects.has(fresh.avatar_key));
});
test('pausing during a larger batch finishes only the current message and retains its checkpoint',async t=>{
 const f=await fixture(t),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');let paused=false;
 f.hook(async key=>{if(!paused&&key.startsWith('imports/')){paused=true;await app.controlMboxJob(f.env,f.user,job.id,'pause');}});
 await app.processMboxJob(f.env,job.id);const row=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(row.status,'paused');assert.equal(row.processed,1);assert.equal(row.byte_offset,Buffer.byteLength(mail(0)));assert.equal(f.DB.db.prepare('SELECT status FROM messages').get().status,'received');
 f.hook(null);await app.controlMboxJob(f.env,f.user,job.id,'resume');const done=await drain(f,job.id);assert.equal(done.imported,13);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,13);
});
test('label transaction failures roll back publication and checkpoint; resume rebuilds exactly once',async t=>{
 const f=await fixture(t,mail('atomic','Inbox,Unread,Work',true));f.DB.db.exec("CREATE TRIGGER reject_label BEFORE INSERT ON message_labels BEGIN SELECT RAISE(ABORT,'Label transaction failed'); END;");
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);const row=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(row.status,'failed');assert.equal(row.byte_offset,0);assert.equal(row.processed,0);assert.equal(f.DB.db.prepare('SELECT status FROM messages').get().status,'importing');
 f.DB.db.exec('DROP TRIGGER reject_label');await app.controlMboxJob(f.env,f.user,job.id,'resume');const done=await drain(f,job.id);assert.equal(done.imported,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
});


test('Takeout decodes the entire localized header before splitting labels or assigning categories',()=>{
 const encoded='=?UTF-8?Q?Kategorie_""Eink=C3=A4ufe"",Posteingang,?=\r\n =?UTF-8?Q?Kategorie:_""Neuigkeiten"",Ungelesen?=';
 const p=app.mboxPlacement(new TextEncoder().encode(mail('real-takeout',encoded)).buffer);
 assert.equal(p.destination.section,'inbox');assert.equal(p.metadata.read,false);assert.deepEqual(p.labels,['Einkäufe','Neuigkeiten']);
 const opened=app.mboxPlacement(new TextEncoder().encode(mail('opened','=?UTF-8?Q?Spam,Ge=C3=B6ffne?= =?UTF-8?Q?t,W?= =?UTF-8?Q?ichtig?=')).buffer);
 assert.equal(opened.destination.section,'spam');assert.equal(opened.metadata.read,true);assert.deepEqual(opened.labels,[]);
 for(const [label,category] of [['Kategorie: ""Werbung""','promotions'],['Kategorie: ""Angebote""','promotions'],['Kategorie ""Soziale Netzwerke""','social'],['Kategorie ""Soziale Medien""','social'],['Kategorie: ""Persönlich""','primary']]){
  const p=app.mboxPlacement(new TextEncoder().encode(mail('categories',`=?UTF-8?B?${Buffer.from('Posteingang,Ungelesen,'+label+',Privat').toString('base64')}?=`)).buffer);
  assert.equal(p.destination.section,'inbox');assert.equal(p.metadata.category,category);assert.equal(p.metadata.read,false);assert.deepEqual(p.labels,['Privat']);
 }
});
test('encoded comma-separated Takeout labels retain correct placement and clean names end to end',async t=>{
 const f=await fixture(t,mail('encoded','=?UTF-8?Q?Posteingang,Ungelesen,Ge=C3=B6ffnet,?= =?UTF-8?Q?Kategorie:_""Werbung"",Abrechnungen_nach_Kategorie?='));
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:404});t.after(()=>globalThis.fetch=originalFetch);
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');const done=await drain(f,job.id);assert.equal(done.imported,1);
 const message=f.DB.db.prepare('SELECT status,category,read FROM messages').get();assert.equal(message.status,'received');assert.equal(message.category,'promotions');assert.equal(message.read,0);
 assert.deepEqual(f.DB.db.prepare('SELECT name FROM folders').all().map(x=>x.name),['Rechnung']);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
});

function clefAnswer(){return {answers:{inbox:{type:'noul',noul:.01},category:{type:'choice',choice:'promotions',probabilities:{primary:.01,promotions:.97,social:.01,spam:.01}},action:{type:'noul',noul:.01},security:{type:'noul',noul:.01}},usage:{input_tokens:50}};}
async function sortingFixture(t,content){const original=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:404});t.after(()=>globalThis.fetch=original);const f=await fixture(t,content);f.aiCalls=[];f.env.AI={run:async(model,input)=>{f.aiCalls.push({model,input});return clefAnswer();}};f.env.REALTIME={getByName:()=>{throw Error('Historical sorting must not send notifications');}};f.job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await drain(f,f.job.id);return f;}
async function drainSorting(f){for(let i=0;i<30;i++){await app.processMboxSortingJob(f.env,f.job.id);const row=f.DB.db.prepare('SELECT * FROM mbox_sorting_jobs').get();if(row.status!=='pending')return row;}throw Error('Sorting did not terminate');}

test('follow-up sorts only unassigned imported inbox mail and retains assigned categories, read flags, labels and objects',async t=>{
 const content=mail('unknown','Inbox,Unread,Work',true)+mail('promotions','Inbox,Unread,Category Promotions')+mail('social','Inbox,Category Social')+mail('spam','Spam')+mail('trash','Trash')+mail('sent','Sent')+mail('draft','Draft')+mail('archived','Read,Work')+mail('security','Inbox,Unread').replace('Mail security','Sicherheitswarnung')+mail('bill','Inbox').replace('Mail bill','Deine Rechnung')+mail('manual','Inbox')+mail('folder','Inbox');
 const f=await sortingFixture(t,content);f.DB.db.exec("UPDATE messages SET sorting_decision='{\"source\":\"manual\",\"category\":\"primary\"}' WHERE subject='Mail manual';UPDATE messages SET folder_id=(SELECT id FROM folders WHERE name='Work') WHERE subject='Mail folder';");
 const before=f.DB.db.prepare('SELECT id,read,starred,status FROM messages ORDER BY id').all(),objects=[...f.objects.keys()].sort(),labels=f.DB.db.prepare('SELECT * FROM message_labels ORDER BY message_id,folder_id').all();
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');const done=await drainSorting(f);assert.equal(done.status,'completed');assert.equal(done.processed,3);assert.equal(done.promotions_count,2);assert.equal(done.primary_count,1);assert.equal(f.aiCalls.length,2);assert.equal(f.aiCalls[0].model,'@cf/cloudflare/clef-omni');
 assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE subject='Mail unknown'").get().category,'promotions');assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE subject='Mail social'").get().category,'social');assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE subject='Sicherheitswarnung'").get().category,'primary');
 assert.deepEqual(f.DB.db.prepare('SELECT id,read,starred,status FROM messages ORDER BY id').all(),before);assert.deepEqual([...f.objects.keys()].sort(),objects);assert.deepEqual(f.DB.db.prepare('SELECT * FROM message_labels ORDER BY message_id,folder_id').all(),labels);
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');await app.processMboxSortingJob(f.env,f.job.id);assert.equal(f.aiCalls.length,2,'replaying a completed job makes no additional model call');
});
test('archive usage stops at half the shared daily budget while new inbound mail can use the remaining quota',async t=>{
 const f=await sortingFixture(t,mail('one')+mail('two')+mail('three'));f.DB.db.exec("INSERT INTO mailbox_sorting_settings(mailbox_id,mode,daily_limit,threshold) VALUES('box','active',4,.8)");const day=new Date().toISOString().slice(0,10);f.DB.db.prepare("INSERT INTO mail_sorting_usage(mailbox_id,day,requests,input_tokens) VALUES('box',?,1,0)").run(day);
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');let job=await drainSorting(f);assert.equal(job.status,'waiting');assert.equal(job.wait_reason,'daily_limit');assert.equal(job.processed,1);assert.equal(f.aiCalls.length,1);assert.equal(f.DB.db.prepare('SELECT requests FROM mail_sorting_usage').get().requests,2);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages WHERE sorting_decision IS NULL').get().n,2);
 const input={mailboxId:'box',userId:'admin',sender:'fresh@example.test',recipient:'owner@example.test',subject:'A fresh message',text:'Hello there',spamScore:0};await app.classifyIncomingMail(f.env,input);await app.classifyIncomingMail(f.env,input);const blocked=await app.classifyIncomingMail(f.env,input);assert.equal(blocked.reason,'daily_limit');assert.equal(f.aiCalls.length,3);assert.equal(f.DB.db.prepare('SELECT requests FROM mail_sorting_usage').get().requests,4);
 f.DB.db.exec('DELETE FROM mail_sorting_usage;UPDATE mbox_sorting_jobs SET retry_at=0');await app.recoverMboxSortingJobs(f.env);assert(f.queue.some(x=>x.kind==='import.sort'));job=await drainSorting(f);assert.equal(job.status,'completed');assert.equal(job.processed,3);
});
test('manual corrections made during a model call take priority and are never counted as applied AI changes',async t=>{
 const f=await sortingFixture(t,mail('manual-race'));f.env.AI.run=async()=>{f.DB.db.exec("UPDATE messages SET sorting_decision='{\"source\":\"manual\",\"category\":\"primary\"}'");return clefAnswer();};
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');const job=await drainSorting(f);assert.equal(job.processed,0);assert.equal(job.status,'completed');const message=f.DB.db.prepare('SELECT category,sorting_decision FROM messages').get();assert.equal(message.category,'primary');assert.equal(JSON.parse(message.sorting_decision).source,'manual');
});
test('separate pause finishes the current classification and resume continues without duplicate charges',async t=>{
 const f=await sortingFixture(t,mail('one')+mail('two'));let paused=false;f.env.AI.run=async()=>{f.aiCalls.push({});if(!paused){paused=true;await app.controlMboxSortingJob(f.env,f.user,f.job.id,'pause');}return clefAnswer();};
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');let job=await drainSorting(f);assert.equal(job.status,'paused');assert.equal(job.processed,1);assert.equal(f.aiCalls.length,1);await app.processMboxSortingJob(f.env,f.job.id);assert.equal(f.aiCalls.length,1);await app.controlMboxSortingJob(f.env,f.user,f.job.id,'resume');job=await drainSorting(f);assert.equal(job.status,'completed');assert.equal(job.processed,2);assert.equal(f.aiCalls.length,2);
});
test('sorting waits for the independent import and picks up newly imported inbox messages',async t=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:404});t.after(()=>globalThis.fetch=original);const f=await fixture(t,Array.from({length:30},(_,i)=>mail(i)).join(''));f.aiCalls=[];f.env.AI={run:async()=>{f.aiCalls.push({});return clefAnswer();}};f.job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,f.job.id);assert.equal(f.DB.db.prepare('SELECT processed FROM mbox_import_jobs').get().processed,25);
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');let job=await drainSorting(f);assert.equal(job.status,'waiting');assert.equal(job.wait_reason,'import');assert.equal(job.processed,25);await app.processMboxJob(f.env,f.job.id);f.DB.db.exec('UPDATE mbox_sorting_jobs SET retry_at=0');await app.recoverMboxSortingJobs(f.env);job=await drainSorting(f);assert.equal(job.status,'completed');assert.equal(job.processed,30);assert.equal(f.aiCalls.length,30);
});
test('AI failures leave categories unchanged and stop after three failures; a resumed job retries the message',async t=>{
 const f=await sortingFixture(t,mail('retry'));f.env.AI.run=async()=>{throw Error('Model service unavailable');};await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');let job;
 for(let i=0;i<3;i++){f.DB.db.exec('UPDATE mbox_sorting_jobs SET retry_at=0');job=await drainSorting(f);assert.equal(f.DB.db.prepare('SELECT category FROM messages').get().category,'primary');assert.equal(f.DB.db.prepare('SELECT sorting_decision FROM messages').get().sorting_decision,null);assert.equal(job.processed,0);}assert.equal(job.status,'failed');
 f.env.AI.run=async()=>clefAnswer();await app.controlMboxSortingJob(f.env,f.user,f.job.id,'resume');job=await drainSorting(f);assert.equal(job.status,'completed');assert.equal(job.processed,1);
});
test('security protection does not trust historical authentication headers; paused/off/foreign jobs cannot classify',async t=>{
 const f=await sortingFixture(t,mail('security','Inbox').replace('Mail security','Sicherheitswarnung').replace('Content-Type:','Authentication-Results: attacker.test; dkim=fail; dmarc=fail\r\nContent-Type:')+mail('regular','Inbox'));
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');f.DB.db.exec("UPDATE mbox_sorting_jobs SET status='running',lease_token='other',lease_until="+(Date.now()+60000));await app.processMboxSortingJob(f.env,f.job.id);assert.equal(f.aiCalls.length,0);
 f.DB.db.exec("UPDATE mbox_sorting_jobs SET lease_until=0;INSERT INTO mailbox_sorting_settings(mailbox_id,mode,daily_limit,threshold) VALUES('box','off',1000,.8)");await app.processMboxSortingJob(f.env,f.job.id);assert.equal(f.DB.db.prepare('SELECT status FROM mbox_sorting_jobs').get().status,'paused');assert.equal(f.aiCalls.length,0);
 f.DB.db.exec("UPDATE mailbox_sorting_settings SET mode='active'");await app.controlMboxSortingJob(f.env,f.user,f.job.id,'resume');const done=await drainSorting(f);assert.equal(done.processed,2);assert.equal(done.primary_count,1);assert.equal(f.aiCalls.length,1);assert.deepEqual(f.aiCalls[0].input.state.authentication,[]);
});
test('admin, ownership and origin checks protect sorting controls and status responses do not leak leases',async t=>{
 const f=await sortingFixture(t,mail('auth'));const context={params:Promise.resolve({id:f.job.id})};assert.equal((await app.sortingControl(f.request({action:'start'},'anon'),context)).status,401);assert.equal((await app.sortingControl(f.request({action:'start'},'owner'),context)).status,403);
 globalThis.__mboxCookie=f.request().headers.get('Authorization').slice(7);assert.equal((await app.sortingControl(new Request('https://mailflare.test/api/import/mbox/jobs/'+f.job.id+'/sorting',{method:'POST',headers:{Origin:'https://attacker.test','Content-Type':'application/json'},body:'{"action":"start"}'}),context)).status,403);delete globalThis.__mboxCookie;
 const response=await app.sortingControl(f.request({action:'start'}),context);assert.equal(response.status,200);assert(!(await response.text()).includes('lease_token'));const list=await(await app.list(f.request())).json();assert.equal(list.jobs[0].sorting.status,'pending');assert.equal(list.sortingAvailable,true);
 f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='admin'");await app.processMboxSortingJob(f.env,f.job.id);assert.equal(f.aiCalls.length,0);assert.match(f.DB.db.prepare('SELECT error FROM mbox_sorting_jobs').get().error,/disabled/);
});
test('new sorting jobs are backed up once, restored paused and remain optional for older backup documents',async t=>{
 const f=await sortingFixture(t,mail('backup'));await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');f.DB.db.exec("UPDATE mbox_sorting_jobs SET status='waiting',lease_token='stale',lease_until=9999999999999");const bytes=await app.exportDatabaseRecords(f.env.DB),doc=JSON.parse(new TextDecoder().decode(bytes));assert.equal(doc.tables.mbox_sorting_jobs.length,1);await app.restoreDatabaseRecords(f.env.DB,bytes.buffer);const restored=f.DB.db.prepare('SELECT * FROM mbox_sorting_jobs').get();assert.equal(restored.status,'paused');assert.equal(restored.lease_token,null);assert.equal(restored.lease_until,0);
 delete doc.tables.mbox_sorting_jobs;doc.includedTables=doc.includedTables.filter(x=>x!=='mbox_sorting_jobs');await app.restoreDatabaseRecords(f.env.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mbox_sorting_jobs').get().n,0);
 const prior=join(dir,'pre-sorting');mkdirSync(prior);for(const name of readdirSync('drizzle/migrations').filter(x=>x.endsWith('.sql')&&x<'0068_'))writeFileSync(join(prior,name),readFileSync(join('drizzle/migrations',name)));const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,prior);
 const old=await app.exportDatabaseRecords(DB);await app.restoreDatabaseRecords(DB,old.buffer);await app.applyMigrations(DB,'drizzle/migrations');
 await app.restoreDatabaseRecords(DB,old.buffer);
});

test('snoozed imports are excluded and historical suspected spam goes to promotions for review',async t=>{
 const f=await sortingFixture(t,mail('snoozed')+mail('suspect'));f.DB.db.prepare("UPDATE messages SET snoozed_until=? WHERE subject='Mail snoozed'").run(Math.floor(Date.now()/1000)+86400);f.DB.db.exec("UPDATE messages SET spam_score=80 WHERE subject='Mail suspect'");f.env.AI.run=async()=>{f.aiCalls.push({});const response=clefAnswer();response.answers.category.choice='spam';response.answers.category.probabilities={primary:.01,promotions:.01,social:.01,spam:.97};return response;};
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');const done=await drainSorting(f);assert.equal(done.processed,1);assert.equal(f.aiCalls.length,1);const message=f.DB.db.prepare("SELECT status,category,sorting_decision FROM messages WHERE subject='Mail suspect'").get();assert.equal(message.status,'received');assert.equal(message.category,'promotions');assert.equal(JSON.parse(message.sorting_decision).reviewRequired,true);assert.equal(f.DB.db.prepare("SELECT sorting_decision FROM messages WHERE subject='Mail snoozed'").get().sorting_decision,null);
});

test('transaction backfill rechecks old primary decisions once and preserves archived status and manual choices',async t=>{
 const f=await sortingFixture(t,mail('bill','Read').replace('Mail bill','Rechnung 2026-123')+mail('order','Inbox').replace('Mail order','Bestellbestätigung #123')+mail('manual','Inbox')+mail('legacy','Inbox'));
 f.DB.db.exec(`UPDATE messages SET category='primary',sorting_decision='{"source":"rule","category":"primary","policyVersion":3}' WHERE subject='Rechnung 2026-123';UPDATE messages SET sorting_decision='{"source":"manual","category":"primary"}' WHERE subject='Mail manual';UPDATE messages SET sorting_decision='{"source":"clef","category":"primary","policyVersion":3}' WHERE subject='Mail legacy'`);
 await app.controlMboxSortingJob(f.env,f.user,f.job.id,'start');const done=await drainSorting(f);assert.equal(done.processed,2);assert.equal(done.invoices_count,1);assert.equal(done.promotions_count,1);assert.equal(f.aiCalls.length,1);
 const invoice=f.DB.db.prepare("SELECT category,status,sorting_decision FROM messages WHERE subject='Rechnung 2026-123'").get();assert.equal(invoice.category,'invoices');assert.equal(invoice.status,'archived');assert.equal(JSON.parse(invoice.sorting_decision).policyVersion,10);
 await app.processMboxSortingJob(f.env,f.job.id);assert.equal(f.aiCalls.length,1);assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE subject='Mail manual'").get().category,'primary');
});

test('transaction migration and legacy backups retain financial label ids, rules, flags and checkpoints',async t=>{
 const prior=join(dir,'pre-transactions');mkdirSync(prior);for(const name of readdirSync('drizzle/migrations').filter(x=>x.endsWith('.sql')&&x<'0069_'))writeFileSync(join(prior,name),readFileSync(join('drizzle/migrations',name)));
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,prior);
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('u','u@example.test','hash','U','admin',1);INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('d','u','example.test','manual','active',1);INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('b','u','d','u',1);INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('finance','u','b','Abrechnungen nach Kategorie',1);INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,category,read,starred,created_at) VALUES('bill','u','b','inbound','billing@example.test','u@example.test','archived','primary',1,1,1),('manual','u','b','inbound','billing@example.test','u@example.test','received','primary',0,0,1);INSERT INTO message_labels(message_id,folder_id) VALUES('bill','finance'),('manual','finance');UPDATE messages SET sorting_decision='{"source":"manual","category":"primary"}' WHERE id='manual';INSERT INTO mbox_import_jobs(id,user_id,mailbox_id,object_key,object_size,object_etag,created_at,updated_at) VALUES('j','u','b','mbox-imports/test',100,'etag',1,1);INSERT INTO mbox_sorting_jobs(import_job_id,user_id,mailbox_id,created_at,updated_at) VALUES('j','u','b',1,1);`);
 DB.db.exec("INSERT INTO mail_sorting_feedback(id,mailbox_id,sender,subject,category,corrected_at) VALUES('confirmed','b','sam@example.test','A real personal message','primary','2026-10-12')");
 const old=await app.exportDatabaseRecords(DB);await app.restoreDatabaseRecords(DB,old.buffer);await app.applyMigrations(DB,'drizzle/migrations');
 assert.equal(DB.db.prepare('SELECT category FROM mail_sorting_feedback').get().category,'primary');assert.equal(DB.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='mail_sorting_feedback_v4'").get().n,0);
 assert.equal(DB.db.prepare("SELECT name FROM folders WHERE id='finance'").get().name,'Rechnung');assert.deepEqual(DB.db.prepare("SELECT category,status,read,starred FROM messages WHERE id='bill'").get(),{category:'invoices',status:'archived',read:1,starred:1});assert.equal(DB.db.prepare("SELECT category FROM messages WHERE id='manual'").get().category,'primary');assert.equal(DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,2);
 DB.db.exec('UPDATE mbox_sorting_jobs SET invoices_count=2,orders_count=3');const current=await app.exportDatabaseRecords(DB);await app.restoreDatabaseRecords(DB,current.buffer);assert.equal(DB.db.prepare('SELECT invoices_count FROM mbox_sorting_jobs').get().invoices_count,2);assert.equal(DB.db.prepare('SELECT orders_count FROM mbox_sorting_jobs').get().orders_count,3);
 await app.restoreDatabaseRecords(DB,old.buffer);assert.equal(DB.db.prepare('SELECT invoices_count FROM mbox_sorting_jobs').get().invoices_count,0);assert.equal(DB.db.prepare('SELECT orders_count FROM mbox_sorting_jobs').get().orders_count,0);
});

test('database import failures report the underlying cause and retry the same checkpoint without exposing SQL',async t=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:404});t.after(()=>globalThis.fetch=original);
 const f=await fixture(t,mail('db-retry','Inbox'));
 f.DB.db.exec("CREATE TRIGGER reject_database_write BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'D1_ERROR: Network connection lost.'); END;");
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);
 const failed=f.DB.db.prepare('SELECT status,error,byte_offset,processed FROM mbox_import_jobs').get();assert.equal(failed.status,'pending');assert.equal(failed.error,'D1_ERROR: Network connection lost.');assert.equal(failed.byte_offset,0);assert.equal(failed.processed,0);assert(!failed.error.includes('insert into'));
 f.DB.db.exec('DROP TRIGGER reject_database_write');await app.controlMboxJob(f.env,f.user,job.id,'resume');const done=await drain(f,job.id);assert.equal(done.imported,1);assert.equal(done.processed,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);
});

test('oversized and invalid individual messages are logged atomically while subsequent mail imports',async t=>{
 const first=mail('large').replace('Hallo Grüße','x'.repeat(21*1024**2)),bad=mail('labels',Array.from({length:101},(_,i)=>'Label'+i).join(',')),last=mail('last');
 const f=await fixture(t,first+bad+last),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');
 const done=await drain(f,job.id);assert.equal(done.status,'completed');assert.equal(done.processed,3);assert.equal(done.imported,1);assert.equal(done.skipped,2);assert.equal(done.byte_offset,done.object_size);
 const rows=f.DB.db.prepare('SELECT * FROM mbox_import_issues ORDER BY byte_offset').all();assert.equal(rows.length,2);assert.equal(rows[0].reason,'oversized');assert.equal(rows[0].next_offset,Buffer.byteLength(first));assert.equal(rows[1].reason,'invalid_message');assert.equal(rows[1].byte_offset,Buffer.byteLength(first));
 assert.deepEqual(f.DB.db.prepare('SELECT subject FROM messages').all(),[{subject:'Mail last'}]);assert.equal(f.DB.db.prepare("SELECT COUNT(*) n FROM messages WHERE status='importing'").get().n,0);
 const download=await app.downloadMboxIssue(f.env,f.user,job.id,rows[0].id);assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(first));
 assert.equal(download.headers.get('Cache-Control'),'private, no-store');assert.match(download.headers.get('Content-Disposition'),/message-0.mbox/);
 await app.reviewMboxIssue(f.env,f.user,job.id,rows[0].id);assert.equal(f.DB.db.prepare('SELECT status FROM mbox_import_issues WHERE id=?').get(rows[0].id).status,'dismissed');assert(f.objects.has('mbox-imports/archive.mbox'));
 const list=await app.listMboxJobs(f.env,f.user,'box');assert.deepEqual(list[0].issues,{total:2,pending:1});
 f.etag('changed');await assert.rejects(app.downloadMboxIssue(f.env,f.user,job.id,rows[1].id),/changed/);
});

test('very large messages scan across queue invocations including unbroken lines without losing the next message',async t=>{
 const first=mail('huge').replace('Hallo Grüße','x'.repeat(70*1024**2)),last=mail('after-huge');
 const f=await fixture(t,first+last),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');
 await app.processMboxJob(f.env,job.id);const scanning=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(scanning.status,'pending');assert.equal(scanning.processed,0);assert.equal(scanning.byte_offset,0);assert(scanning.scan_offset>32*1024**2);assert.equal(scanning.scan_starts_line,0);
 await app.controlMboxJob(f.env,f.user,job.id,'pause');await app.processMboxJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT scan_offset FROM mbox_import_jobs').get().scan_offset,scanning.scan_offset);
 await app.controlMboxJob(f.env,f.user,job.id,'resume');const done=await drain(f,job.id);assert.equal(done.status,'completed');assert.equal(done.processed,2);assert.equal(done.imported,1);assert.equal(done.skipped,1);assert.equal(done.scan_offset,0);
 const issue=f.DB.db.prepare('SELECT * FROM mbox_import_issues').get();assert.equal(issue.byte_offset,0);assert.equal(issue.next_offset,Buffer.byteLength(first));assert.equal(f.DB.db.prepare('SELECT subject FROM messages').get().subject,'Mail after-huge');
 assert(f.calls.filter(x=>x.key==='mbox-imports/archive.mbox').every(x=>x.length<=2*1024**2));
});

test('D1 oversized body errors are quarantined and partial message objects are cleaned',async t=>{
 const f=await fixture(t,mail('big-row','Inbox,Unread',true)+mail('next','Inbox'));
 f.DB.db.exec("CREATE TRIGGER reject_big_row BEFORE INSERT ON message_attachments BEGIN SELECT RAISE(ABORT,'D1_ERROR: Row too big: SQLITE_TOOBIG'); END;");
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox'),done=await drain(f,job.id);assert.equal(done.status,'completed');assert.equal(done.skipped,1);assert.equal(done.imported,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_attachments').get().n,0);
 assert.equal(f.DB.db.prepare('SELECT reason FROM mbox_import_issues').get().reason,'invalid_message');assert(!f.objects.has(`imports/msg_mbox_${job.id}_0.eml`));
});

test('a failed issue log never advances the checkpoint or loses the source message',async t=>{
 const f=await fixture(t,mail('bad',Array.from({length:101},(_,i)=>'L'+i).join(','))+mail('next','Inbox'));
 f.DB.db.exec("CREATE TRIGGER reject_issue BEFORE INSERT ON mbox_import_issues BEGIN SELECT RAISE(ABORT,'D1_ERROR: Network connection lost.'); END;");
 const job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await app.processMboxJob(f.env,job.id);const failed=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(failed.status,'pending');assert.equal(failed.byte_offset,0);assert.equal(failed.processed,0);assert.equal(failed.skipped,0);
 f.DB.db.exec('DROP TRIGGER reject_issue');await app.controlMboxJob(f.env,f.user,job.id,'resume');const done=await drain(f,job.id);assert.equal(done.skipped,1);assert.equal(done.imported,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mbox_import_issues').get().n,1);
});

test('temporary storage outages retry automatically and never skip mail or disregard backoff',async t=>{
 const f=await fixture(t,mail('retry','Inbox')),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');f.fail(true);
 await app.processMboxJob(f.env,job.id);let row=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(row.status,'pending');assert.equal(row.consecutive_failures,1);assert(row.retry_at>Date.now());assert.equal(row.processed,0);
 const calls=f.calls.length;await app.processMboxJob(f.env,job.id);assert.equal(f.calls.length,calls);await app.recoverMboxJobs(f.env);assert.equal(f.queue.length,2);
 f.DB.db.exec('UPDATE mbox_import_jobs SET retry_at=0');await app.processMboxJob(f.env,job.id);row=f.DB.db.prepare('SELECT * FROM mbox_import_jobs').get();assert.equal(row.consecutive_failures,2);assert(row.retry_at-Date.now()>110000);
 f.fail(false);f.DB.db.exec('UPDATE mbox_import_jobs SET retry_at=0');const done=await drain(f,job.id);assert.equal(done.imported,1);assert.equal(done.skipped,0);assert.equal(done.consecutive_failures,0);assert.equal(f.DB.db.prepare('SELECT COUNT(*) n FROM mbox_import_issues').get().n,0);
});

test('issue logs restore with paused jobs and remain optional in legacy backups',async t=>{
 const f=await fixture(t,mail('bad',Array.from({length:101},(_,i)=>'L'+i).join(','))),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await drain(f,job.id);
 f.DB.db.exec("UPDATE mbox_import_jobs SET status='pending',scan_offset=55,scan_size=30,retry_at=9999999999999");
 const bytes=await app.exportDatabaseRecords(f.env.DB),doc=JSON.parse(new TextDecoder().decode(bytes));assert.equal(doc.tables.mbox_import_issues.length,1);
 await app.restoreDatabaseRecords(f.env.DB,bytes.buffer);assert.equal(f.DB.db.prepare('SELECT status FROM mbox_import_jobs').get().status,'paused');assert.equal(f.DB.db.prepare('SELECT scan_offset FROM mbox_import_jobs').get().scan_offset,55);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mbox_import_issues').get().n,1);
 delete doc.tables.mbox_import_issues;doc.includedTables=doc.includedTables.filter(x=>x!=='mbox_import_issues');for(const j of doc.tables.mbox_import_jobs)for(const field of ['scan_offset','scan_size','scan_starts_line','retry_at','consecutive_failures'])delete j[field];
 await app.restoreDatabaseRecords(f.env.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mbox_import_issues').get().n,0);assert.equal(f.DB.db.prepare('SELECT scan_offset FROM mbox_import_jobs').get().scan_offset,0);
});

test('issue list, download and review enforce admin, mailbox access, job scope and mutation origin',async t=>{
 const f=await fixture(t,mail('bad',Array.from({length:101},(_,i)=>'L'+i).join(','))),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');await drain(f,job.id);const issue=f.DB.db.prepare('SELECT id FROM mbox_import_issues').get().id,ctx={params:Promise.resolve({id:job.id})};
 const get=await app.issuesGet(f.request(),ctx);assert.equal(get.status,200);assert.equal((await get.json()).issues.length,1);assert.equal((await app.issuesGet(f.request(undefined,'owner'),ctx)).status,403);assert.equal((await app.issuesGet(f.request(undefined,'unknown'),ctx)).status,401);
 await assert.rejects(app.listMboxIssues(f.env,f.user,'nonexistent'),/not found/);await assert.rejects(app.downloadMboxIssue(f.env,f.user,job.id,'foreign'),/not found/);
 globalThis.__mboxCookie=f.request().headers.get('Authorization').slice(7);const hostile=f.request({issueId:issue,action:'dismiss'});hostile.headers.delete('Authorization');hostile.headers.set('Origin','https://evil.test');assert.equal((await app.issuesPost(hostile,ctx)).status,403);delete globalThis.__mboxCookie;
 const updated=await app.issuesPost(f.request({issueId:issue,action:'dismiss'}),ctx);assert.equal(updated.status,200);
 f.DB.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='box'");assert.equal((await app.issuesGet(f.request(),ctx)).status,400);
});


test('paginated review traverses every issue once without exposing job leases',async t=>{
 const bad=Array.from({length:23},(_,i)=>mail('bad'+i,Array.from({length:101},(_,j)=>'L'+j).join(','))).join(''),f=await fixture(t,bad),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox');const done=await drain(f,job.id);assert.equal(done.skipped,23);
 const first=await app.listMboxIssues(f.env,f.user,job.id);assert.equal(first.issues.length,20);assert.equal(first.next,first.issues[19].byte_offset);const last=await app.listMboxIssues(f.env,f.user,job.id,first.next);assert.equal(last.issues.length,3);assert.equal(last.next,null);assert.equal(new Set([...first.issues,...last.issues].map(x=>x.id)).size,23);assert(!JSON.stringify(first).includes('lease'));
});

test('malformed MIME is isolated from subsequent valid messages',async t=>{
 let raw=mail('nested','Inbox').split('Content-Type:')[0];for(let i=0;i<300;i++)raw+=`Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;raw+='Content-Type: text/plain\r\n\r\nBody\r\n';for(let i=299;i>=0;i--)raw+=`--b${i}--\r\n`;
 const f=await fixture(t,raw+mail('valid','Inbox')),job=await app.createMboxJob(f.env,f.user,'box','mbox-imports/archive.mbox'),done=await drain(f,job.id);assert.equal(done.status,'completed');assert.equal(done.imported,1);assert.equal(done.skipped,1);assert.equal(f.DB.db.prepare('SELECT reason FROM mbox_import_issues').get().reason,'invalid_message');assert.equal(f.DB.db.prepare('SELECT subject FROM messages').get().subject,'Mail valid');
});
