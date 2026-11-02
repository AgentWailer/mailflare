import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=mkdtempSync(join(process.cwd(),'node_modules','preview-background-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined}}');
// Model the response lifecycle: callbacks cannot start until the host closes it.
writeFileSync(join(dir,'server.mjs'),`export const NextResponse=Response; export const after=task=>globalThis.__previewAfter.push(task);`);
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database'; export {applyMigrations} from './server/runtime/migrate'; export {createSession} from './src/lib/auth/session'; export {GET as list} from './src/app/api/messages/route';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':join(dir,'server.mjs'),'cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);

async function fixture(t,count=1){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,'drizzle/migrations');
 t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__previewAfter;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1),('foreign','foreign@example.test','hash','Foreign','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('foreign-box','foreign','domain','foreign','personal',1);`);
 const add=DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,status,category,read,created_at) VALUES(?,?,?,'inbound','sender@example.test','owner@example.test','Subject',?,?,'received','primary',0,1)");
 for(let i=0;i<count;i++)add.run('mail-'+i,'owner','box','Read online https://example.test/link','Your appointment is tomorrow at ten.');
 add.run('foreign-mail','foreign','foreign-box','https://example.test/private','Private body');
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;globalThis.__previewAfter=[];
 const token=await app.createSession(env,'owner');
 const list=(box='box')=>app.list(new Request('https://mailflare.test/api/messages?mailboxId='+box+'&limit=100',{headers:{Authorization:'Bearer '+token}}));
 return {DB,list};
}

test('list returns without any legacy-body query or write; deferred repair updates the next response only',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let bodyReads=0,release;
 const blocked=new Promise(resolve=>release=resolve);
 f.DB.prepare=sql=>{
  const statement=prepare(sql);
  if(!sql.includes('substr('))return statement;
  return {bind(...args){const bound=statement.bind(...args);return {...bound,raw:async(...options)=>{bodyReads++;await blocked;return bound.raw(...options);}};}};
 };
 const response=await f.list(),data=await response.json();
 assert.equal(response.status,200);assert.equal(bodyReads,0);assert.equal(globalThis.__previewAfter.length,1);
 assert.equal(data.messages[0].snippet,'Read online');assert.equal(f.DB.db.prepare("SELECT snippet FROM messages WHERE id='mail-0'").get().snippet,'Read online https://example.test/link');
 const repair=globalThis.__previewAfter.shift()();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(bodyReads,1);release();await repair;
 assert.equal((await (await f.list()).json()).messages[0].snippet,'Your appointment is tomorrow at ten.');
 assert.equal(globalThis.__previewAfter.length,0,'clean pages schedule no repair');
 assert.equal(f.DB.db.prepare("SELECT snippet FROM messages WHERE id='foreign-mail'").get().snippet,'https://example.test/private');
 assert.equal(f.DB.db.prepare("SELECT read FROM messages WHERE id='mail-0'").get().read,0);
});

test('repair remains bounded to 25 visible messages and inaccessible mailboxes schedule no work',async t=>{
 const f=await fixture(t,40);
 assert.equal((await f.list('foreign-box')).status,404);assert.equal(globalThis.__previewAfter.length,0);
 assert.equal((await f.list()).status,200);await globalThis.__previewAfter.shift()();
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE mailbox_id='box' AND snippet='Your appointment is tomorrow at ten.'").get().n,25);
 assert.equal(f.DB.db.prepare("SELECT snippet FROM messages WHERE id='foreign-mail'").get().snippet,'https://example.test/private');
});

test('failed repair cannot turn an already delivered list into an error or alter messages',async t=>{
 const f=await fixture(t),response=await f.list(),prepare=f.DB.prepare.bind(f.DB);
 f.DB.prepare=sql=>{if(sql.includes('substr('))throw new Error('temporary database failure');return prepare(sql);};
 await assert.doesNotReject(globalThis.__previewAfter.shift()());
 assert.equal(response.status,200);assert.equal((await response.json()).messages.length,1);
 assert.equal(f.DB.db.prepare("SELECT snippet FROM messages WHERE id='mail-0'").get().snippet,'Read online https://example.test/link');
});
