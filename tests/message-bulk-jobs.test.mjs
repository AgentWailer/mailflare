import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-read-all-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:name=>name==="ep_session"&&globalThis.__readAllCookie?{value:globalThis.__readAllCookie}:undefined};}');
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
 export {createSession} from './src/lib/auth/session';
 export {POST as idBulk} from './src/app/api/messages/bulk/route';
 export {POST as bulkScope} from './src/app/api/messages/bulk-scope/route';
 export {POST as markRead} from './src/app/api/messages/read-all/route';
 export {GET as list} from './src/app/api/messages/route';
 export {GET as counts} from './src/app/api/messages/counts/route';
 export {processBulkJob,recoverBulkJobs,latestBulkJob} from './src/lib/messages/bulk-jobs';
 export {POST as createJob,GET as jobStatus,PATCH as controlJob} from './src/app/api/messages/bulk-jobs/route';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export';
 export {getMessageFolderParams} from './src/lib/messages/folder-params';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__readAllCookie;});
 await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 // Match Cloudflare D1's binding limit rather than SQLite's larger local default.
 const prepare=DB.prepare.bind(DB);DB.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...values)=>{assert(values.length<=100,'D1 statement exceeds 100 bound parameters');return bind(...values);};return statement;};
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','admin',1),('reader','reader@example.test','hash','Reader','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('private','other','domain','private','personal',1),('shared','owner','domain','shared','shared',1);
 INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES ('access','reader','shared','read_only',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('label','owner','box','Work',1);`);
 const insert=DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,category,read,created_at) VALUES (?,?,?,'inbound','sender@example.test','owner@example.test',? ,?,?,0,1)`);
 const add=(id,{mailbox='box',status='received',category='primary',subject='Work note'}={})=>insert.run(id,mailbox==='private'?'other':'owner',mailbox,subject,status,category);
 const queued=[],deletedObjects=[];const env={DB,AGENT_QUEUE:{send:async body=>queued.push(body)},MAILFLARE_RUNTIME:'node',BUCKET:{delete:async key=>deletedObjects.push(key)}};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['owner','other','reader']) tokens[id]=await app.createSession(env,id);
 const request=(body,user='owner',path='/api/messages/read-all')=>new Request('https://mailflare.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens[user],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const chunk=async(input,user='owner')=>{const response=await app.markRead(request(input,user));assert.equal(response.status,200);return response.json();};
 const continuation=data=>({snapshot:data.snapshot,after:data.after,actorId:data.actorId,mailboxIds:data.mailboxIds});
 const scopeChunk=async input=>{const response=await app.bulkScope(request(input));assert.equal(response.status,200);return response.json();};
 const complete=async(scope,action,selection,extra={})=>{let context=continuation(selection),total=0,data;do{data=await scopeChunk({...scope,...context,action,...extra});total+=data.messageIds.length;context=continuation(data);}while(!data.done);return total;};
 return {DB,env,queued,add,request,chunk,continuation,tokens,scopeChunk,complete,deletedObjects};
}


const scope={folder:'inbox',mailboxId:'box',query:'',unreadOnly:false,title:'Posteingang'};
async function create(f,action='read',extra={},actor='owner'){
 const response=await app.createJob(f.request({input:{folder:'inbox',mailboxId:'box',action,...extra},scope,requestId:'request-'+action},actor));assert.equal(response.status,202);return (await response.json()).job;
}
const row=(f,id)=>f.DB.db.prepare('SELECT * FROM message_bulk_jobs WHERE id=?').get(id);
async function drain(f,id){for(let i=0;i<1000&&row(f,id).status!=='completed';i++){await app.processBulkJob(f.env,id);const saved=row(f,id);assert(!['failed','waiting'].includes(saved.status),saved.error);}assert.equal(row(f,id).status,'completed');}

test('20,000 emails complete on queue alone after browser closes; new arrivals stay unread',async t=>{
 const f=await fixture(t);f.DB.db.transaction(()=>{for(let i=0;i<20000;i++)f.add('mail-'+i);})();f.add('foreign',{mailbox:'private'});
 const job=await create(f);assert.equal(job.total,20000);assert.equal(f.queued[0].kind,'messages.bulk');f.add('new-arrival');
 await drain(f,job.id);assert.equal(row(f,job.id).processed,20000);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages WHERE read=1').get().n,20000);assert.equal(f.DB.db.prepare("SELECT read FROM messages WHERE id='new-arrival'").get().read,0);
 const status=await (await app.jobStatus(f.request(null,'owner','/api/messages/bulk-jobs'))).json();assert.equal(status.job.processed,20000);assert.equal(status.job.status,'done');
});
test('idempotent acceptance, duplicate queue delivery and lease recovery cannot duplicate progress',async t=>{
 const f=await fixture(t);for(let i=0;i<1001;i++)f.add('mail-'+i);const job=await create(f);assert.equal((await create(f)).id,job.id);
 await Promise.all([app.processBulkJob(f.env,job.id),app.processBulkJob(f.env,job.id)]);assert.equal(row(f,job.id).processed,960);
 f.DB.db.prepare("UPDATE message_bulk_jobs SET lease_token='crashed',lease_until=1,status='running' WHERE id=?").run(job.id);f.queued.length=0;await app.recoverBulkJobs(f.env);assert.equal(f.queued[0].jobId,job.id);await drain(f,job.id);await app.processBulkJob(f.env,job.id);assert.equal(row(f,job.id).processed,1001);
});
test('lost checkpoint after applied unread-filter chunk replays its saved IDs safely',async t=>{
 const f=await fixture(t);for(let i=0;i<81;i++)f.add('mail-'+i);const job=await create(f,'read',{read:'unread'});
 const original=f.DB.prepare.bind(f.DB);let fail=true;f.DB.prepare=sql=>{const statement=original(sql);const bind=statement.bind.bind(statement);statement.bind=(...values)=>{const bound=bind(...values);if(sql.startsWith('UPDATE message_bulk_jobs SET after_row=')&&fail){fail=false;bound.first=async()=>{throw Error('Temporary lost checkpoint');};}return bound;};return statement;};
 await app.processBulkJob(f.env,job.id);assert.equal(row(f,job.id).status,'waiting');assert.equal(row(f,job.id).processed,0);assert(row(f,job.id).pending_chunk);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages WHERE read=1').get().n,80);
 f.DB.db.prepare('UPDATE message_bulk_jobs SET retry_at=0 WHERE id=?').run(job.id);await drain(f,job.id);assert.equal(row(f,job.id).processed,81);
});
test('partial permanent deletion resumes without losing the remaining messages of the pending chunk',async t=>{
 const f=await fixture(t);for(let i=0;i<8;i++){f.add('mail-'+i,{status:'trash'});f.DB.db.prepare('UPDATE messages SET raw_r2_key=? WHERE id=?').run('raw-'+i,'mail-'+i);}
 let calls=0,failed=false;f.env.BUCKET.delete=async()=>{calls++;if(calls===3&&!failed){failed=true;throw Error('R2 temporarily unavailable');}};
 const job=await create(f,'delete',{folder:'trash'});await app.processBulkJob(f.env,job.id);assert.equal(row(f,job.id).status,'waiting');assert(row(f,job.id).pending_chunk);assert(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n<8);
 f.DB.db.prepare('UPDATE message_bulk_jobs SET retry_at=0 WHERE id=?').run(job.id);await drain(f,job.id);assert.equal(row(f,job.id).processed,8);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,0);
});
test('disabled accounts and revoked/read-only grants stop write jobs; job status/control stay private',async t=>{
 const f=await fixture(t);for(let i=0;i<1001;i++)f.add('mail-'+i,{mailbox:'shared'});
 const blocked=await app.createJob(f.request({input:{folder:'all',mailboxId:'shared',action:'trash'},scope,requestId:'forbidden'},'reader'));assert.equal(blocked.status,404);
 const allowed=await create(f,'read',{folder:'all',mailboxId:'shared'},'reader');await app.processBulkJob(f.env,allowed.id);f.DB.db.exec("DELETE FROM mailbox_access WHERE user_id='reader'");await app.processBulkJob(f.env,allowed.id);assert.equal(row(f,allowed.id).status,'failed');assert.equal(row(f,allowed.id).processed,960);
 const privateJob=await create(f,'read');const other=await (await app.jobStatus(f.request(null,'other'))).json();assert.equal(other.job,null);
 const request=new Request('https://mailflare.test/api/messages/bulk-jobs',{method:'PATCH',headers:{Authorization:'Bearer '+f.tokens.other,'Content-Type':'application/json'},body:JSON.stringify({id:privateJob.id,action:'retry'})});assert.equal((await app.controlJob(request)).status,404);
 f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");await app.processBulkJob(f.env,privateJob.id);assert.equal(row(f,privateJob.id).status,'failed');
});
test('backup contains jobs, restore pauses old row-id snapshots, and legacy backups remain valid',async t=>{
 const f=await fixture(t);f.add('one');const job=await create(f);const backup=await app.exportDatabaseRecords(f.DB);const doc=JSON.parse(new TextDecoder().decode(backup));assert.equal(doc.tables.message_bulk_jobs.length,1);
 await app.restoreDatabaseRecords(f.DB,backup.buffer);assert.equal(row(f,job.id).status,'paused');assert.equal((await app.latestBulkJob(f.env,'owner')).canRetry,false);await app.processBulkJob(f.env,job.id);assert.equal(f.DB.db.prepare('SELECT read FROM messages').get().read,0);
 delete doc.tables.message_bulk_jobs;doc.includedTables=doc.includedTables.filter(x=>x!=='message_bulk_jobs');await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_bulk_jobs').get().n,0);
 f.DB.db.exec('DROP TABLE message_bulk_jobs');const beforeMigration=await app.exportDatabaseRecords(f.DB);assert.deepEqual(JSON.parse(new TextDecoder().decode(beforeMigration)).tables.message_bulk_jobs,[]);await app.restoreDatabaseRecords(f.DB,beforeMigration.buffer);
});

test('acceptance survives queue outage and cron recovers it; destructive scope and CSRF checks run before acceptance',async t=>{
 const f=await fixture(t);f.add('mail');f.env.AGENT_QUEUE.send=async()=>{throw Error('Queue unavailable');};const job=await create(f);assert.equal(row(f,job.id).status,'pending');
 f.env.AGENT_QUEUE.send=async body=>f.queued.push(body);await app.recoverBulkJobs(f.env);assert.equal(f.queued.at(-1).jobId,job.id);await drain(f,job.id);
 assert.equal((await app.createJob(f.request({input:{folder:'inbox',mailboxId:'box',action:'delete'},scope,requestId:'unsafe-delete'}))).status,400);
 globalThis.__readAllCookie=f.tokens.owner;const csrf=new Request('https://mailflare.test/api/messages/bulk-jobs',{method:'POST',headers:{Origin:'https://foreign.test'},body:JSON.stringify({input:{folder:'inbox',action:'trash'},scope,requestId:'csrf'})});assert.equal((await app.createJob(csrf)).status,403);delete globalThis.__readAllCookie;
});

test('labels, archive, unread and move actions use the same durable selection',async t=>{
 const f=await fixture(t);for(let i=0;i<91;i++)f.add('mail-'+i);let job=await create(f,'organize',{organization:{addLabelIds:['label'],category:'invoices'}});await drain(f,job.id);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,91);
 job=await create(f,'archive',{folder:'invoices'});await drain(f,job.id);assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE status='archived'").get().n,91);
 job=await create(f,'read',{folder:'all'});await drain(f,job.id);job=await create(f,'unread',{folder:'all'});await drain(f,job.id);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages WHERE read=0').get().n,91);
 job=await create(f,'folder',{folder:'all',destinationFolderId:'label'});await drain(f,job.id);assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE folder_id='label'").get().n,91);
});
