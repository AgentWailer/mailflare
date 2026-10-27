import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
test('creation retries reuse one user-scoped draft; completed drafts cannot be recreated',async t=>{
 const dir=mkdtempSync(join(process.cwd(),'node_modules','draft-idempotency-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
 await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createSession} from './src/lib/auth/session';export {POST} from './src/app/api/drafts/route';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
 const app=await import(pathToFileURL(join(dir,'app.mjs'))),DB=new app.SqliteDatabase(':memory:');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});await app.applyMigrations(DB,'drizzle/migrations');
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1); INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','manual','active',1);INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('otherbox','other','domain','other','personal',1);`);
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;
 const owner=await app.createSession(env,'owner'),other=await app.createSession(env,'other'),requestId=crypto.randomUUID();
 const create=(token,mailboxId='box',from='owner@example.test')=>app.POST(new Request('https://mailflare.test/api/drafts',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({mailboxId,from,requestId,text:'Recovery test'})}));
 const a=await create(owner);assert.equal(a.status,200);const id=(await a.json()).draft.id;const b=await create(owner);assert.equal((await b.json()).draft.id,id);assert.equal(DB.db.prepare('SELECT count(*) AS n FROM messages').get().n,1);
 assert.equal((await create(other)).status,403);const c=await create(other,'otherbox','other@example.test');assert.equal(c.status,200);assert.notEqual((await c.json()).draft.id,id);
 DB.db.prepare("UPDATE messages SET status='sent' WHERE id=?").run(id);assert.equal((await create(owner)).status,409);
});
