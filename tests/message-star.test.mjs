import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','message-star-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createSession} from './src/lib/auth/session';export {POST} from './src/app/api/messages/[messageId]/star/route';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/server':'next/server.js','next/headers':'next/headers.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','hash','Owner',1),('other','other@example.test','hash','Other',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('foreign','other','domain','other','personal',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,starred,created_at) VALUES('mail','owner','box','inbound','sender@example.test','owner@example.test','received',0,1),('secret','other','foreign','inbound','sender@example.test','other@example.test','received',0,1);`);
 const env={DB};globalThis.__mailflareNodeEnv=env;const token=await app.createSession(env,'owner');
 const call=(body,id='mail',authenticated=true)=>app.POST(new Request(`https://mailflare.test/api/messages/${id}/star`,{method:'POST',headers:{Origin:'https://mailflare.test',Authorization:'Bearer '+(authenticated?token:'invalid-token'),'Content-Type':'application/json'},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),{params:Promise.resolve({messageId:id})});
 return {DB,call,star:(id='mail')=>DB.db.prepare('SELECT starred FROM messages WHERE id=?').get(id).starred};
}
test('setting the intended star state is repeatable after a lost response and avoids redundant writes',async t=>{
 const f=await fixture(t);const first=await f.call({starred:true});assert.equal(first.status,200);assert.deepEqual(await first.json(),{starred:true});
 const before=f.DB.db.prepare('SELECT total_changes() n').get().n;
 const retry=await f.call({starred:true});assert.deepEqual(await retry.json(),{starred:true});assert.equal(f.star(),1);assert.equal(f.DB.db.prepare('SELECT total_changes() n').get().n,before,'retries do not create revision/write churn');
 assert.deepEqual(await (await f.call({starred:false})).json(),{starred:false});assert.equal(f.star(),0);
});
test('legacy empty requests still toggle, while invalid and oversized desired state do not mutate',async t=>{
 const f=await fixture(t);assert.equal((await f.call()).status,200);assert.equal(f.star(),1);assert.equal((await f.call()).status,200);assert.equal(f.star(),0);
 for(const body of [{starred:'true'},null,[], '{broken'])assert.equal((await f.call(body)).status,400);
 assert.equal((await f.call({starred:true,padding:'x'.repeat(1100)})).status,413);assert.equal(f.star(),0);
});
test('explicit star state retains authenticated mailbox isolation',async t=>{
 const f=await fixture(t);assert.equal((await f.call({starred:true},'secret')).status,404);assert.equal(f.star('secret'),0);assert.equal((await f.call({starred:true},'mail',false)).status,401);assert.equal(f.star(),0);
});
