import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-label-order-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>globalThis.__testCookieToken?{value:globalThis.__testCookieToken}:undefined};}');
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database.ts';export {applyMigrations} from './server/runtime/migrate.ts';export {createSession} from './src/lib/auth/session.ts';export {GET,PATCH} from './src/app/api/settings/label-order/route.ts';export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__testCookieToken;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('delegate','delegate@example.test','hash','Delegate','user',1),('foreign','foreign@example.test','hash','Foreign','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','shared',1),('other','foreign','domain','foreign','personal',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('work','owner','box','Work',1),('family','owner','box','Family',1),('secret','foreign','other','Secret',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,parent_id,created_at) VALUES ('child','owner','box','Child','work',1);
 INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('access','box','delegate','read_only',1);`);
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;const tokens={};for(const actor of ['owner','delegate','foreign'])tokens[actor]=await app.createSession(env,actor);
 const request=(actor='owner',body,box='box')=>new Request('https://mailflare.test/api/settings/label-order?mailboxId='+box,{method:body?'PATCH':'GET',headers:{...(tokens[actor]?{Authorization:'Bearer '+tokens[actor]}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const save=(order,parentId=null,actor='owner',extra={})=>app.PATCH(request(actor,{mailboxId:'box',parentId,order,...extra}));
 const read=async(actor='owner')=>{const r=await app.GET(request(actor));assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'private, no-store');return (await r.json()).orders;};
 return {DB,request,save,read};
}
test('a second device reads the saved order; users and sibling groups remain independent',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.read(),{});
 assert.equal((await f.save(['family','work'])).status,200);assert.deepEqual(await f.read(),{root:['family','work']});
 await Promise.all([f.save(['child'],'work'),f.save(['work','family'])]);assert.deepEqual(await f.read(),{root:['work','family'],work:['child']});
 assert.equal((await f.save(['family','work'],null,'delegate')).status,200);assert.deepEqual(await f.read('delegate'),{root:['family','work']});assert.deepEqual((await f.read()).root,['work','family']);
 assert.equal(f.DB.db.prepare("SELECT parent_id FROM folders WHERE id='child'").get().parent_id,'work');
});
test('legacy browser adoption never replaces an order already saved on another device',async t=>{
 const f=await fixture(t);await f.save(['family','work'],null,'owner',{onlyIfAbsent:true});await f.save(['work','family'],null,'owner',{onlyIfAbsent:true});assert.deepEqual((await f.read()).root,['family','work']);
});
test('auth, mailbox isolation, strict validation and cookie-origin protection',async t=>{
 const f=await fixture(t);assert.equal((await app.GET(f.request('missing'))).status,401);assert.equal((await f.save(['work'],null,'missing')).status,401);
 assert.equal((await app.GET(f.request('delegate',undefined,'other'))).status,404);
 assert.equal((await f.save(['secret'])).status,404);assert.equal((await f.save(['work'],'secret')).status,404);
 for(const body of [{mailboxId:'box',parentId:null,order:['work','work']},{mailboxId:'box',parentId:null,order:['work'],userId:'foreign'},{mailboxId:'box',parentId:'bad"path',order:[]}])assert.equal((await app.PATCH(f.request('owner',body))).status,400);
 const authenticated=f.request('owner',{mailboxId:'box',parentId:null,order:['work']});const token=authenticated.headers.get('Authorization').slice(7);authenticated.headers.delete('Authorization');authenticated.headers.set('Cookie','ep_session='+token);authenticated.headers.set('Origin','https://foreign.test');
 globalThis.__testCookieToken=token;
 assert.equal((await app.PATCH(authenticated)).status,403);assert.deepEqual(await f.read(),{});
});
test('backup/restore retains server order and pre-feature backups use the empty default',async t=>{
 const f=await fixture(t);await f.save(['family','work']);const backup=await app.exportDatabaseRecords(f.DB);await f.save(['work','family']);await app.restoreDatabaseRecords(f.DB,backup.buffer);assert.deepEqual((await f.read()).root,['family','work']);
 const legacy=JSON.parse(new TextDecoder().decode(backup));for(const user of legacy.tables.users)delete user.label_order;await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(legacy)).buffer);assert.deepEqual(await f.read(),{});
});
