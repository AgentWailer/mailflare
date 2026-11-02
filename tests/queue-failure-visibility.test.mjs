import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=mkdtempSync(join(process.cwd(),'node_modules','queue-failure-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createSession} from './src/lib/auth/session';export * from './src/lib/queues/failures';export {GET} from './src/app/api/admin/queue-health/route';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));

async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');
 t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});
 await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec("INSERT INTO users(id,email,password_hash,name,role,is_primary_admin,created_at) VALUES('owner','owner@example.test','hash','Owner','admin',1,1),('delegate','delegate@example.test','hash','Delegate','admin',0,1),('reader','reader@example.test','hash','Reader','user',0,1)");
 const env={DB};globalThis.__mailflareNodeEnv=env;
 return {env,DB};
}

test('only final retry failures persist; payloads, identifiers and exception contents never enter the notice',async t=>{
 const {env,DB}=await fixture(t),now=Date.now();
 const body={rawR2Key:'PRIVATE-RAW-KEY',from:'secret@example.test',to:'private@example.test',subject:'PRIVATE-SUBJECT',messageId:'PRIVATE-MESSAGE'};
 for(const attempt of [1,2,3,NaN,Infinity,-1]) await app.recordFinalQueueFailure(env,body,attempt,new TypeError('PRIVATE-CONTENT'),now);
 assert.equal(DB.db.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
 await app.recordFinalQueueFailure(env,body,4,new TypeError('PRIVATE-CONTENT'),now);
 const row=DB.db.prepare('SELECT * FROM audit_logs').get();
 assert.deepEqual(JSON.parse(row.metadata),{kind:'inbound',category:'TypeError',attempts:4});
 for(const field of ['actor_user_id','target_user_id','mailbox_id','message_id']) assert.equal(row[field],null);
 assert(!JSON.stringify(row).includes('PRIVATE'));assert(!JSON.stringify(row).includes('@'));
 const status=await app.getQueueFailureStatus(env,now);
 assert.equal(status.count,1);assert.equal(status.hasMore,false);assert.equal(status.recent[0].kind,'inbound');
});

test('status queries stay bounded and use the existing primary-key index amidst unrelated audit traffic',async t=>{
 const {env,DB}=await fixture(t),now=Date.now();
 DB.db.transaction(()=>{const insert=DB.db.prepare("INSERT INTO audit_logs(id,action,metadata,created_at) VALUES(?,'auth.login','{}',?)");for(let n=0;n<1000;n++)insert.run('aud_'+n,Math.floor(now/1000));})();
 await app.recordFinalQueueFailure(env,{kind:'email.scheduled'},4,new Error('private'),now-8*86400000);
 for(let n=0;n<105;n++)await app.recordFinalQueueFailure(env,{kind:'messages.bulk'},4,new Error('private'),now-n);
 const queries=[],prepare=DB.prepare.bind(DB);DB.prepare=sql=>{queries.push(sql);return prepare(sql);};
 const status=await app.getQueueFailureStatus(env,now);
 assert.equal(status.count,100);assert.equal(status.hasMore,true);assert.equal(status.recent.length,5);
 assert(status.recent.every(item=>item.kind==='bulk'));
 assert.equal(queries.length,1);assert.match(queries[0],/WHERE id >= \? AND id < \?/);assert.match(queries[0],/LIMIT \?/);
 const plan=DB.db.prepare('EXPLAIN QUERY PLAN '+queries[0]).all('queue_failure_0000000000000_','queue_failure_9999999999999_','queue.processing_failed',101);
 assert(plan.some(row=>/SEARCH audit_logs USING INDEX sqlite_autoindex_audit_logs/.test(row.detail)),JSON.stringify(plan));
});

test('unknown stages and corrupted metadata cannot expose arbitrary diagnostic contents',async t=>{
 const {env,DB}=await fixture(t),now=Date.now();
 await app.recordFinalQueueFailure(env,{kind:'PRIVATE-STAGE'},4,new Error('PRIVATE-ERROR'),now);
 assert.equal((await app.getQueueFailureStatus(env,now)).recent[0].kind,'unknown');
 DB.db.prepare('UPDATE audit_logs SET metadata=?').run(JSON.stringify({kind:'PRIVATE-STAGE',category:'PRIVATE-CONTENT',attempts:'PRIVATE-ATTEMPT',from:'private@example.test'}));
 const notice=(await app.getQueueFailureStatus(env,now)).recent[0];
 assert.equal(notice.kind,'unknown');assert.equal(notice.category,'Error');assert.equal(notice.attempts,0);assert(!JSON.stringify(notice).includes('PRIVATE'));
 DB.db.exec("UPDATE audit_logs SET metadata='broken json'");assert.equal((await app.getQueueFailureStatus(env,now)).recent[0].kind,'unknown');
});

test('only the primary admin can retrieve notices; all responses are private and never cached',async t=>{
 const {env}=await fixture(t);
 for(const [id,expected] of [[null,401],['reader',403],['delegate',403],['owner',200]]){
  const token=id?await app.createSession(env,id):null;
  const response=await app.GET(new Request('https://mail.test/api/admin/queue-health',{headers:token?{Authorization:'Bearer '+token}:{}}));
  assert.equal(response.status,expected);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  if(id==='owner')assert.equal((await response.json()).count,0);
 }
});

test('database failures never prevent queue retry handling and never log their content',async t=>{
 const logs=[],original=console.error;console.error=(...values)=>logs.push(values);t.after(()=>console.error=original);
 await app.recordFinalQueueFailure({DB:{prepare(){throw new Error('PRIVATE-SQL-AND-VALUES');}}},{kind:'email.scheduled'},4,new Error('PRIVATE-MAIL'));
 assert.equal(logs.length,1);assert(!JSON.stringify(logs).includes('PRIVATE'));assert.deepEqual(logs[0][1],{error:'Error'});
 const {env}=await fixture(t),token=await app.createSession(env,'owner'),prepare=env.DB.prepare.bind(env.DB);
 env.DB.prepare=sql=>{if(sql.includes('FROM audit_logs'))throw new Error('PRIVATE-SQL');return prepare(sql);};
 const response=await app.GET(new Request('https://mail.test/api/admin/queue-health',{headers:{Authorization:'Bearer '+token}}));
 assert.equal(response.status,503);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.deepEqual(await response.json(),{error:'queue_status_unavailable'});assert(!JSON.stringify(logs).includes('PRIVATE'));
});

test('final-attempt reporting follows all configured queue retry limits and leaves DLQ routing intact',()=>{
 const config=readFileSync('wrangler.jsonc','utf8'),limits=[...config.matchAll(/"max_retries":\s*(\d+)/g)].map(match=>Number(match[1]));
 assert.equal(limits.length,3);assert(limits.every(limit=>limit===app.QUEUE_MAX_RETRIES));
 assert.equal([...config.matchAll(/"dead_letter_queue":\s*"mailflare-failed"/g)].length,3);
});
