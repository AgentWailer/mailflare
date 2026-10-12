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
 export {POST as markRead} from './src/app/api/messages/read-all/route';
 export {GET as list} from './src/app/api/messages/route';
 export {GET as counts} from './src/app/api/messages/counts/route';
 export {getMessageFolderParams} from './src/lib/messages/folder-params';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__readAllCookie;});
 await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','admin',1),('reader','reader@example.test','hash','Reader','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('private','other','domain','private','personal',1),('shared','owner','domain','shared','shared',1);
 INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES ('access','reader','shared','read_only',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('label','owner','box','Work',1);`);
 const insert=DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,category,read,created_at) VALUES (?,?,?,'inbound','sender@example.test','owner@example.test',? ,?,?,0,1)`);
 const add=(id,{mailbox='box',status='received',category='primary',subject='Work note'}={})=>insert.run(id,mailbox==='private'?'other':'owner',mailbox,subject,status,category);
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['owner','other','reader']) tokens[id]=await app.createSession(env,id);
 const request=(body,user='owner',path='/api/messages/read-all')=>new Request('https://mailflare.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens[user],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const chunk=async(input,user='owner')=>{const response=await app.markRead(request(input,user));assert.equal(response.status,200);return response.json();};
 const continuation=data=>({snapshot:data.snapshot,after:data.after,actorId:data.actorId,mailboxIds:data.mailboxIds});
 return {DB,add,request,chunk,continuation,tokens};
}

test('folder-wide marking covers more than 25, updates exact counts, uses bounded idempotent chunks and preserves incoming mail',async t=>{
 const f=await fixture(t);for(let i=0;i<451;i++)f.add('mail-'+i);
 for(const [id,opts] of [['promotion',{category:'promotions'}],['spam',{status:'spam'}],['private',{mailbox:'private'}],['snoozed',{}],['labelled',{}]])f.add(id,opts);
 f.DB.db.exec(`UPDATE messages SET snoozed_until=9999999999 WHERE id='snoozed';UPDATE messages SET folder_id='label' WHERE id='labelled'`);
 const scope={folder:'inbox',mailboxId:'box'};let result=await f.chunk(scope);assert.equal(result.messageIds.length,200);assert.equal(result.total,451);assert.equal(result.done,false);
 const checkpoint=f.continuation(result);f.add('arrived-during-task');f.add('imported-old-date');
 let marked=result.messageIds.length;while(!result.done){result=await f.chunk({...scope,...checkpoint});assert(result.messageIds.length<=200);marked+=result.messageIds.length;Object.assign(checkpoint,f.continuation(result));}
 assert.equal(marked,451);assert.equal((await f.chunk({...scope,...checkpoint})).messageIds.length,0);
 for(const id of ['promotion','spam','private','snoozed','labelled','arrived-during-task','imported-old-date'])assert.equal(f.DB.db.prepare('SELECT read FROM messages WHERE id=?').get(id).read,0,id);
 const counts=await (await app.counts(f.request(null,'owner','/api/messages/counts?mailboxId=box'))).json();assert.equal(counts.counts.folders.inbox.unread,2);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM audit_logs WHERE action='message.read_all'").get().n,1);
});

test('label and financial archive scopes match the actual paginated list',async t=>{
 const f=await fixture(t);f.add('label-primary');f.add('label-ad',{category:'promotions'});f.add('label-archived',{status:'archived'});f.add('invoice-archived',{category:'invoices',status:'archived'});f.add('invoice',{category:'invoices'});f.add('order',{category:'orders'});f.add('unlabelled');
 for(const id of ['label-primary','label-ad','label-archived'])f.DB.db.prepare('INSERT INTO message_labels(message_id,folder_id) VALUES (?,\'label\')').run(id);
 for(const scope of [{folder:'inbox',mailboxId:'box',folderId:'label'},{folder:'invoices',mailboxId:'box'}]){
  const params=app.getMessageFolderParams(scope.folder,scope.mailboxId,scope.folderId);
  const listed=await (await app.list(f.request(null,'owner','/api/messages?'+params))).json();
  const result=await f.chunk(scope);assert.deepEqual(result.messageIds.sort(),listed.messages.map(m=>m.id).sort());
 }
 assert.equal(f.DB.db.prepare("SELECT read FROM messages WHERE id='order'").get().read,0);
});

test('search, unread filter and starred scope do not reach other matches or other categories',async t=>{
 const f=await fixture(t);f.add('wanted',{subject:'Invoice work'});f.add('other-subject',{subject:'Other'});f.add('ad',{subject:'Invoice work',category:'promotions'});
 assert.deepEqual((await f.chunk({folder:'inbox',mailboxId:'box',q:'subject:Invoice',read:'unread'})).messageIds,['wanted']);
 f.DB.db.exec("UPDATE messages SET starred=1 WHERE id='ad'");assert.deepEqual((await f.chunk({folder:'starred',mailboxId:'box'})).messageIds,['ad']);
 assert.equal(f.DB.db.prepare("SELECT read FROM messages WHERE id='other-subject'").get().read,0);
});

test('authentication, origin, invalid scopes and account changes cannot mark foreign mail',async t=>{
 const f=await fixture(t);f.add('private',{mailbox:'private'});f.add('owner');
 assert.equal((await app.markRead(new Request('https://mailflare.test/api/messages/read-all',{method:'POST',body:'{}'}))).status,401);
 assert.equal((await app.markRead(f.request({folder:'inbox',mailboxId:'private'}))).status,404);
 assert.equal((await app.markRead(f.request({folder:'anything'}))).status,400);
 assert.equal((await app.markRead(f.request({folder:'inbox',snapshot:1}))).status,400);
 assert.equal((await app.markRead(f.request({folder:'all',actorId:'other'}))).status,409);
 const csrf=new Request('https://mailflare.test/api/messages/read-all',{method:'POST',headers:{Origin:'https://foreign.test','Sec-Fetch-Site':'cross-site',Cookie:'ep_session='+f.tokens.owner},body:JSON.stringify({folder:'all'})});globalThis.__readAllCookie=f.tokens.owner;assert.equal((await app.markRead(csrf)).status,403);delete globalThis.__readAllCookie;
 assert.equal(f.DB.db.prepare('SELECT sum(read) n FROM messages').get().n,0);
 assert.deepEqual((await f.chunk({folder:'all'})).messageIds,['owner']);
 assert.equal(f.DB.db.prepare("SELECT read FROM messages WHERE id='private'").get().read,0);
});

test('read-only shared mailboxes allow read state changes but revoked grants stop subsequent chunks',async t=>{
 const f=await fixture(t);for(let i=0;i<240;i++)f.add('shared-'+i,{mailbox:'shared'});
 const result=await f.chunk({folder:'all',mailboxId:'shared'},'reader');assert.equal(result.messageIds.length,200);
 f.DB.db.exec("DELETE FROM mailbox_access WHERE user_id='reader'");
 assert.equal((await app.markRead(f.request({folder:'all',mailboxId:'shared',...f.continuation(result)},'reader'))).status,404);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE mailbox_id='shared' AND read=0").get().n,40);
});
