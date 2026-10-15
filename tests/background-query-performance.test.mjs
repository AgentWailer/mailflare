import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const directory=mkdtempSync(join(process.cwd(),'node_modules','background-query-performance-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {processInboundMessage} from './src/lib/email/inbound';export {runTrashRetention} from './src/lib/email/trash-retention';`,resolveDir:process.cwd()},outfile:join(directory,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(directory,'app.mjs')).href);
const now=new Date('2026-10-15T12:00:00Z'),old=Math.floor(now.getTime()/1000)-40*86400,recent=Math.floor(now.getTime()/1000)-86400;
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,trash_retention_days,created_at) VALUES('owner','owner@example.test','hash','Owner',30,1),('other','other@example.test','hash','Other',NULL,1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('otherbox','other','domain','other','personal',1);`);
 const reads=[],deleted=[],queries=[],prepare=DB.prepare.bind(DB);
 DB.prepare=sql=>{queries.push(sql);return prepare(sql);};
 const env={DB,BUCKET:{get:async key=>{reads.push(key);return null;},delete:async key=>deleted.push(key)}};
 const insert=DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,raw_r2_key,trashed_at,text_body,html_body,created_at) VALUES(?,?,?,'inbound','sender@example.test','owner@example.test',?,?,?,'Body','<p>Body</p>',1)`);
 const setTrashDate=DB.db.prepare('UPDATE messages SET trashed_at=? WHERE id=?');
 const add=(id,{owner='owner',box='box',status='archived',key=null,trashed=null}={})=>{
  insert.run(id,owner,box,status,key,trashed);
  // The real trigger timestamps new trash; move that timestamp back to model old mail.
  if(status==='trash'||status==='spam')setTrashDate.run(trashed,id);
 };
 return {DB,env,queries,reads,deleted,add};
}
function assertSelectivePlan(DB,sql,index){
 assert(sql,'the production handler executed the candidate query');
 const details=DB.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...Array((sql.match(/\?/g)||[]).length).fill(null)).map(row=>row.detail).join('\n');
 assert.match(details,new RegExp(`SEARCH messages USING INDEX ${index} \\(`));assert(!details.includes('SCAN messages'),details);
}

test('inbound deduplication and retention use selective indexes without ANALYZE beside a 60,000-message archive',async t=>{
 const f=await fixture(t);f.DB.db.transaction(()=>{for(let i=0;i<60000;i++)f.add('archive-'+i);})();
 // Existing imports may use a legacy ID, and a raw object can occur in another mailbox.
 f.add('foreign-copy',{owner:'other',box:'otherbox',key:'same-object'});f.add('legacy-inbound',{key:'same-object'});
 await app.processInboundMessage(f.env,{from:'sender@example.test',to:'owner@example.test',rawR2Key:'same-object'});
 assert.deepEqual(f.reads,[],'a retried delivery never downloads or inserts the MIME again');
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE raw_r2_key='same-object'").get().n,2);
 assertSelectivePlan(f.DB,f.queries.find(sql=>sql.includes('indexed by messages_raw_r2_key_idx')),'messages_raw_r2_key_idx');
 for(const [id,status]of [['expired-trash','trash'],['expired-spam','spam']])f.add(id,{status,trashed:old,key:id+'.eml'});
 f.add('foreign-trash',{owner:'other',box:'otherbox',status:'trash',trashed:old});f.add('recent',{status:'trash',trashed:recent});f.add('no-date',{status:'trash'});f.add('archived-with-date',{trashed:old});
 assert.equal(await app.runTrashRetention(f.env,now),2);assert.deepEqual(new Set(f.deleted),new Set(['expired-trash.eml','expired-spam.eml']));
 for(const id of ['foreign-trash','recent','no-date','archived-with-date','legacy-inbound'])assert(f.DB.db.prepare('SELECT id FROM messages WHERE id=?').get(id),id);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE id LIKE 'archive-%'").get().n,60000);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM audit_logs WHERE action='email.delete' AND json_extract(metadata,'$.source')='retention'").get().n,2);
 assertSelectivePlan(f.DB,f.queries.find(sql=>sql.includes('indexed by messages_trashed_at_idx')),'messages_trashed_at_idx');
});

test('a raw object stored only in another mailbox never suppresses this mailbox delivery',async t=>{
 const f=await fixture(t);f.add('foreign',{owner:'other',box:'otherbox',key:'foreign-only'});t.mock.method(console,'error',()=>{});
 await app.processInboundMessage(f.env,{from:'sender@example.test',to:'owner@example.test',rawR2Key:'foreign-only'});
 assert.deepEqual(f.reads,['foreign-only']);assert(f.DB.db.prepare("SELECT id FROM messages WHERE id='foreign'").get());
});

test('indexed retention keeps the existing 200-message budget and disabled owner policy',async t=>{
 const f=await fixture(t);f.DB.db.transaction(()=>{for(let i=0;i<225;i++)f.add('expired-'+i,{status:i%2?'spam':'trash',trashed:old});for(let i=0;i<10;i++)f.add('keep-'+i,{owner:'other',box:'otherbox',status:'trash',trashed:old});})();
 assert.equal(await app.runTrashRetention(f.env,now),200);assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE user_id='owner'").get().n,25);assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE user_id='other'").get().n,10);
});
