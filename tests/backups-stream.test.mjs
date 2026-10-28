import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','backup-stream-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createBackupRecord,listBackups} from './src/lib/backups/service';export {processDatabaseBackup,enqueueDatabaseBackup,recoverDatabaseBackups} from './src/lib/backups/runner';export {restoreDatabaseRecords} from './src/lib/backups/export';export {planDatabaseBackup,nextDatabaseBackupPart,initialBackupCursor} from './src/lib/backups/stream';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));t.after(()=>DB.db.close());
 DB.db.exec("INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','hash','Owner',1);INSERT INTO domains(id,user_id,hostname,zone_id,created_at) VALUES('domain','owner','example.test','manual',1);INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('box','owner','domain','owner',1)");
 const objects=new Map(),uploads=new Map(),queue=[],partSizes=[],querySizes=[];let uploadCount=0,completeCount=0,loseComplete=false,failPart=false;
 const BUCKET={
  createMultipartUpload:async(key)=>{const id='upload-'+(++uploadCount);uploads.set(id,new Map());return BUCKET.resumeMultipartUpload(key,id);},
  resumeMultipartUpload:(key,id)=>({uploadId:id,uploadPart:async(number,value)=>{if(failPart){failPart=false;throw Error('temporary upload failure');}const bytes=Buffer.from(value);uploads.get(id).set(number,bytes);partSizes.push(bytes.length);return {partNumber:number,etag:'part-'+number};},complete:async(parts)=>{completeCount++;const data=parts.map(p=>uploads.get(id).get(p.partNumber));for(const part of data.slice(0,-1))assert.equal(part.length,5*1024*1024);objects.set(key,Buffer.concat(data));if(loseComplete){loseComplete=false;throw Error('lost completion response');}return {size:objects.get(key).length};},abort:async()=>uploads.delete(id)}),
  put:async(key,value)=>{objects.set(key,Buffer.from(value));return {size:objects.get(key).length};},
  get:async key=>objects.has(key)?{arrayBuffer:async()=>Uint8Array.from(objects.get(key)).buffer}:null,
  head:async key=>objects.has(key)?{size:objects.get(key).length}:null,
  list:async({prefix})=>({objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false}),
  delete:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])objects.delete(key);},
 };
 const original=DB.prepare.bind(DB);DB.prepare=sql=>{const statement=original(sql);function guard(target){const all=target.all.bind(target);target.all=async()=>{const result=await all();if(sql.includes('__mailflare_backup_rowid')){const size=Buffer.byteLength(JSON.stringify(result.results));querySizes.push(size);assert(size<600*1024,'D1 result must stay bounded even for a large table');}return result;};return target;}const bind=statement.bind.bind(statement);statement.bind=(...values)=>guard(bind(...values));return guard(statement);};
 const env={DB,BUCKET,AGENT_QUEUE:{send:async body=>queue.push(body)},MAILFLARE_RUNTIME:'node'};
 const add=DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,created_at) VALUES(?,'owner','box','inbound','sender@example.test','owner@example.test',?,?,'received',1)");
 const row=id=>DB.db.prepare('SELECT * FROM backups WHERE id=?').get(id);
 const drain=async id=>{for(let n=0;n<100&&row(id).status!=='completed';n++){await app.processDatabaseBackup(env,id);assert.notEqual(row(id).status,'failed',row(id).error);assert.equal(row(id).lease_until,0,row(id).error);}assert.equal(row(id).status,'completed');return JSON.parse(objects.get(row(id).r2_key).toString());};
 return {DB,env,objects,queue,partSizes,querySizes,add,row,drain,loseCompletion:()=>loseComplete=true,failNextPart:()=>failPart=true,completeCount:()=>completeCount};
}

test('large backups use bounded D1 pages and fixed R2 parts, finishing after the browser closes',async t=>{
 const f=await fixture(t);const text='Line\n"Quoted"\tGrüße 🌍 '.repeat(400);
 f.DB.db.transaction(()=>{for(let i=0;i<1200;i++)f.add.run('mail-'+i,'Invoice '+i,text);})();
 const id=await app.createBackupRecord(f.env,'manual','owner');await app.enqueueDatabaseBackup(f.env,id);assert.equal(f.queue[0].kind,'database.backup');
 await app.processDatabaseBackup(f.env,id);assert.equal(f.row(id).status,'running');f.add.run('new-arrival','Later','New');
 const doc=await f.drain(id);assert.equal(doc.format,'mailflare-database-backup');assert.equal(doc.tables.messages.length,1200);assert.equal(doc.tables.messages[0].text_body,text);assert(!doc.tables.messages.some(row=>row.id==='new-arrival'));assert(f.partSizes.length>1);assert(f.querySizes.length>1);assert(!JSON.stringify(doc).includes('__mailflare_backup_rowid'));
 assert.equal([...f.objects.keys()].filter(key=>key.includes('/carry-')).length,0);
 const list=await app.listBackups(f.env);assert(!('checkpoint' in list[0]));assert(!('leaseToken' in list[0]));
 await app.restoreDatabaseRecords(f.DB,Uint8Array.from(f.objects.get(f.row(id).r2_key)).buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1200);assert.equal(f.row(id).status,'failed');assert.equal(f.row(id).checkpoint,null);
});

test('small backups remain version 1 JSON, with excluded groups and negative rowids preserved',async t=>{
 const f=await fixture(t);f.DB.db.exec("UPDATE users SET rowid=-1 WHERE id='owner'");const plan=await app.planDatabaseBackup(f.DB,['assistant']);let cursor=app.initialBackupCursor(),carry,done=false;const chunks=[];
 while(!done){const part=await app.nextDatabaseBackupPart(f.DB,plan,cursor,carry,127);chunks.push(Buffer.from(part.content));cursor=part.cursor;carry=part.carry;done=part.done;}
 const doc=JSON.parse(Buffer.concat(chunks));assert.equal(doc.tables.users[0].id,'owner');assert(!('agent_jobs' in doc.tables));assert.equal(doc.version,1);
});

test('duplicate deliveries share a lease, and a lost completion response is recovered without duplicating the upload',async t=>{
 const f=await fixture(t);f.add.run('mail','Hello','World');const id=await app.createBackupRecord(f.env,'manual','owner');f.loseCompletion();await Promise.all([app.processDatabaseBackup(f.env,id),app.processDatabaseBackup(f.env,id)]);assert.equal(f.row(id).status,'running');assert(f.row(id).lease_until>Date.now());assert.equal(f.completeCount(),1);
 f.DB.db.prepare('UPDATE backups SET lease_until=0 WHERE id=?').run(id);await app.recoverDatabaseBackups(f.env);assert.equal(f.queue.at(-1).jobId,id);await f.drain(id);assert.equal(f.completeCount(),1);
});

test('a failed R2 part retains its previous cursor and retries safely',async t=>{
 const f=await fixture(t);f.add.run('mail','Hello','Original');const id=await app.createBackupRecord(f.env,'manual','owner');f.failNextPart();await app.processDatabaseBackup(f.env,id);const checkpoint=JSON.parse(f.row(id).checkpoint);assert.equal(checkpoint.parts.length,0);assert.equal(checkpoint.cursor.started,false);
 f.DB.db.prepare('UPDATE backups SET lease_until=0 WHERE id=?').run(id);const doc=await f.drain(id);assert.equal(doc.tables.messages.length,1);assert.equal(doc.tables.messages[0].text_body,'Original');
});

test('Reply-To survives new backups and old records without the column still restore',async t=>{
 const f=await fixture(t);f.add.run('mail','Subject','Body');
 f.DB.db.exec("UPDATE messages SET reply_to='support@example.test' WHERE id='mail'");
 const id=await app.createBackupRecord(f.env,'manual','owner');
 const doc=await f.drain(id);assert.equal(doc.tables.messages[0].reply_to,'support@example.test');
 await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);
 assert.equal(f.DB.db.prepare("SELECT reply_to FROM messages WHERE id='mail'").get().reply_to,'support@example.test');
 delete doc.tables.messages[0].reply_to;
 await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);
 assert.equal(f.DB.db.prepare("SELECT reply_to FROM messages WHERE id='mail'").get().reply_to,null);
});
