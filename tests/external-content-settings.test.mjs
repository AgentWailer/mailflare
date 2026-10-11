import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-external-content-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`
export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
export {applyMigrations} from './server/runtime/migrate.ts';
export {createSession} from './src/lib/auth/session.ts';
export {GET,PATCH} from './src/app/api/settings/external-content/route.ts';
export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const oldMigrations=join(dir,'old-migrations');mkdirSync(oldMigrations);
for(const name of readdirSync('drizzle/migrations').filter(name=>name.endsWith('.sql')&&name<'0065'))copyFileSync(join('drizzle/migrations',name),join(oldMigrations,name));
async function fixture(t,old=false){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});
 await app.applyMigrations(DB,old?oldMigrations:join(process.cwd(),'drizzle/migrations'));
 DB.db.exec("INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','admin',1)");
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['owner','other'])tokens[id]=await app.createSession(env,id);
 const request=(actor='owner',body,raw=false)=>new Request('https://mailflare.test/api/settings/external-content',{method:body===undefined?'GET':'PATCH',headers:{'Content-Type':'application/json',...(tokens[actor]?{Authorization:'Bearer '+tokens[actor]}:{})},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});
 return {DB,request};
}
test('new and existing accounts default to allowed; migration preserves account data',async t=>{
 const f=await fixture(t,true);await app.applyMigrations(f.DB,join(process.cwd(),'drizzle/migrations'));
 assert.equal(f.DB.db.prepare("SELECT allow_external_content value FROM users WHERE id='owner'").get().value,1);
 assert.equal(f.DB.db.prepare("SELECT name FROM users WHERE id='owner'").get().name,'Owner');
 f.DB.db.exec("INSERT INTO users(id,email,password_hash,name,created_at) VALUES('new','new@example.test','hash','New',1)");
 assert.equal(f.DB.db.prepare("SELECT allow_external_content value FROM users WHERE id='new'").get().value,1);
 const response=await app.GET(f.request());assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.deepEqual(await response.json(),{enabled:true});
});
test('saved preference is personal and persists across sessions and browsers',async t=>{
 const f=await fixture(t);assert.equal((await app.PATCH(f.request('owner',{enabled:false}))).status,200);
 assert.deepEqual(await(await app.GET(f.request())).json(),{enabled:false});
 assert.deepEqual(await(await app.GET(f.request('other'))).json(),{enabled:true});
 assert.equal((await app.PATCH(f.request('other',{enabled:false}))).status,200);
 assert.equal((await app.PATCH(f.request('owner',{enabled:true}))).status,200);
 assert.deepEqual(await(await app.GET(f.request())).json(),{enabled:true});
 assert.deepEqual(await(await app.GET(f.request('other'))).json(),{enabled:false});
});
test('anonymous, disabled and non-session callers cannot change the setting',async t=>{
 const f=await fixture(t);
 assert.equal((await app.GET(f.request('anonymous'))).status,401);assert.equal((await app.PATCH(f.request('anonymous',{enabled:false}))).status,401);
 f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");assert.equal((await app.GET(f.request())).status,401);
});
test('invalid booleans, foreign user IDs and malformed JSON do not change preferences',async t=>{
 const f=await fixture(t);for(const body of [{},{enabled:'false'},{enabled:null},{enabled:false,userId:'other'}])assert.equal((await app.PATCH(f.request('owner',body))).status,400);
 assert.equal((await app.PATCH(f.request('owner','{',true))).status,400);
 assert.deepEqual(await(await app.GET(f.request())).json(),{enabled:true});assert.deepEqual(await(await app.GET(f.request('other'))).json(),{enabled:true});
});
test('backups before and after migration restore; legacy backups default to allowed',async t=>{
 const old=await fixture(t,true);const backup=await app.exportDatabaseRecords(old.DB);await app.restoreDatabaseRecords(old.DB,backup.buffer);
 await app.applyMigrations(old.DB,join(process.cwd(),'drizzle/migrations'));await app.restoreDatabaseRecords(old.DB,backup.buffer);
 assert.equal(old.DB.db.prepare("SELECT allow_external_content value FROM users WHERE id='owner'").get().value,1);
 old.DB.db.exec("UPDATE users SET allow_external_content=0 WHERE id='owner'");const updated=await app.exportDatabaseRecords(old.DB);
 const parsed=JSON.parse(new TextDecoder().decode(updated));assert.equal(parsed.tables.users.find(x=>x.id==='owner').allow_external_content,0);
 old.DB.db.exec("UPDATE users SET allow_external_content=1 WHERE id='owner'");await app.restoreDatabaseRecords(old.DB,updated.buffer);
 assert.equal(old.DB.db.prepare("SELECT allow_external_content value FROM users WHERE id='owner'").get().value,0);
 const f=await fixture(t,true);await app.restoreDatabaseRecords(f.DB,updated.buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM users').get().n,2);
 assert(readFileSync('src/lib/migrations/bundle.json','utf8').includes('0065_external_content_preference.sql'));
});
