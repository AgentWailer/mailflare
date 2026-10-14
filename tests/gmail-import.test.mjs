import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-gmail-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),"export async function cookies(){return {get:name=>name==='ep_session'&&globalThis.__gmailTestCookie?{value:globalThis.__gmailTestCookie}:undefined};}");
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database.ts';export {applyMigrations} from './server/runtime/migrate.ts';
 export {createSession,hashSessionToken,getUserFromSession} from './src/lib/auth/session.ts';export {getDb} from './src/db/index.ts';
 export {gmailConfiguration,beginGoogleAuthorization,completeGoogleAuthorization,encryptGoogleTokens,decryptGoogleTokens,GMAIL_SCOPE} from './src/lib/import/gmail-oauth.ts';
 export {createGmailJob,advanceGmailJob,gmailPlacement,skipGmailMessage,publicGmailJob} from './src/lib/import/gmail-jobs.ts';
 export {GET as status} from './src/app/api/import/gmail/route.ts';export {POST as connect} from './src/app/api/import/gmail/connect/route.ts';export {GET as callback} from './src/app/api/import/gmail/callback/route.ts';
 export {POST as create} from './src/app/api/import/gmail/jobs/route.ts';export {POST as advance} from './src/app/api/import/gmail/jobs/[id]/route.ts';
 export {DELETE as disconnect} from './src/app/api/import/gmail/connections/[id]/route.ts';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const oldDir=join(dir,'old');mkdirSync(oldDir);for(const name of readdirSync('drizzle/migrations').filter(n=>n.endsWith('.sql')&&n<'0066'))copyFileSync(join('drizzle/migrations',name),join(oldDir,name));
async function fixture(t,old=false){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,old?oldDir:join(process.cwd(),'drizzle/migrations'));
 t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__gmailTestCookie;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('foreign','other','domain','other','personal',1);`);
 const objects=new Map();const env={DB,MAILFLARE_RUNTIME:'node',GMAIL_OAUTH_CLIENT_ID:'test-client',GMAIL_OAUTH_CLIENT_SECRET:'test-secret',GMAIL_OAUTH_REDIRECT_URI:'https://mailflare.test/api/import/gmail/callback',GMAIL_IMPORT_ENCRYPTION_KEY:btoa('k'.repeat(32)),BUCKET:{put:async(k,v)=>objects.set(k,v),delete:async k=>objects.delete(k)}};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const u of ['owner','other'])tokens[u]=await app.createSession(env,u);
 const request=(path='/api/import/gmail',body,actor='owner')=>new Request('https://mailflare.test'+path,{method:body===undefined?'GET':'POST',headers:{...(tokens[actor]?{Authorization:'Bearer '+tokens[actor]}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 // The legacy backup fixture intentionally predates current user columns.
 const user=old?null:await app.getUserFromSession(env,tokens.owner);
 return {DB,env,objects,tokens,request,user};
}
const json=data=>Response.json(data);
async function addConnection(f,expired=false){
 const tokens=await app.encryptGoogleTokens(f.env,'owner:google',{access_token:'access-test',refresh_token:'refresh-test',expiresAt:expired?1:Date.now()+3600000});
 f.DB.db.prepare("INSERT INTO gmail_import_connections(id,user_id,email,tokens,created_at) VALUES('google','owner','owner@workspace.test',?,1)").run(tokens);
}
const raw=(id,attachment=false)=>new TextEncoder().encode(`From: Sender <sender@example.test>\r\nTo: owner@example.test\r\nBcc: secret@example.test\r\nMessage-ID: <google-${id}@example.test>\r\nDate: Wed, 1 Jan 2025 12:00:00 +0000\r\nSubject: Gmail ${id}\r\nMIME-Version: 1.0\r\n${attachment?'Content-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nHello\r\n--part\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="test.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\ncGRm\r\n--part--':'Content-Type: text/plain; charset=utf-8\r\n\r\nHello'}`);
function google(t,{ids=['one','two','three','four','five','six','seven','eight'],failId,expireFirst=false,holdId,largeId,extraLabels=0}={}){
 const calls=[];let fail=!!failId,unauthorized=expireFirst,release,holding=!!holdId;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  url=new URL(url);calls.push({path:url.pathname,method:options.method??'GET',auth:options.headers?.Authorization});
  if(url.hostname==='oauth2.googleapis.com')return json({access_token:'new-access',expires_in:3600,refresh_token:'refresh-test',scope:app.GMAIL_SCOPE});
  if(url.pathname.endsWith('/profile'))return json({emailAddress:'owner@workspace.test'});
  if(unauthorized){unauthorized=false;return new Response(null,{status:401});}
  if(url.pathname.endsWith('/labels'))return json({labels:[{id:'a',name:'Work',type:'user'},{id:'b',name:'Clients/Project',type:'user',color:{backgroundColor:'#123456'}},{id:'INBOX',name:'INBOX',type:'system'},...Array.from({length:extraLabels},(_,i)=>({id:'extra-'+i,name:'Bulk/Label-'+i,type:'user'}))]});
  if(url.pathname.endsWith('/messages')){const offset=url.searchParams.get('pageToken')==='page2'?4:0;return json({messages:ids.slice(offset,offset+4).map(id=>({id})),...(offset===0&&ids.length>4?{nextPageToken:'page2'}:{}),resultSizeEstimate:ids.length});}
  const id=url.pathname.split('/').at(-1);
  if(id===holdId&&holding)await new Promise(resolve=>release=resolve);
  if(id===failId&&fail)return new Response(null,{status:429});
  const tags={one:['INBOX','STARRED','a','b'],two:['SENT','UNREAD','a'],three:['DRAFT'],four:['SPAM','UNREAD'],five:['TRASH'],six:['CATEGORY_PROMOTIONS','UNREAD','a'],seven:['INBOX','CATEGORY_SOCIAL','b'],eight:[]};
  if(url.searchParams.get('format')==='metadata')return json({id,sizeEstimate:id===largeId?41*1024*1024:raw(id).byteLength});
  return json({id,threadId:['one','two'].includes(id)?'conversation':id,labelIds:[...(tags[id]??['INBOX']),...Array.from({length:extraLabels},(_,i)=>'extra-'+i)],internalDate:'1735732800000',raw:Buffer.from(raw(id,id==='one')).toString('base64url')});
 });
 return {calls,fix:()=>fail=false,release:()=>{holding=false;release?.();},held:()=>!!release};
}
test('configuration reports missing fields and rejects malformed keys/callbacks',()=>{
 assert(!app.gmailConfiguration({}).configured);assert(!app.gmailConfiguration({GMAIL_IMPORT_ENCRYPTION_KEY:btoa('short')}).configured);
 assert(!app.gmailConfiguration({GMAIL_OAUTH_CLIENT_ID:'x',GMAIL_OAUTH_CLIENT_SECRET:'x',GMAIL_IMPORT_ENCRYPTION_KEY:btoa('x'.repeat(32)),GMAIL_OAUTH_REDIRECT_URI:'http://mailflare.test/api/import/gmail/callback'}).configured);
});
test('Google credentials use randomized authenticated encryption bound to the user/connection',async t=>{
 const f=await fixture(t),value={access_token:'access',refresh_token:'refresh',expiresAt:Date.now()+3600000};
 const a=await app.encryptGoogleTokens(f.env,'owner:google',value),b=await app.encryptGoogleTokens(f.env,'owner:google',value);
 assert.notEqual(a,b);assert(!a.includes('refresh'));assert.deepEqual(await app.decryptGoogleTokens(f.env,'owner:google',a),value);
 await assert.rejects(app.decryptGoogleTokens(f.env,'other:google',a));await assert.rejects(app.decryptGoogleTokens({...f.env,GMAIL_IMPORT_ENCRYPTION_KEY:btoa('z'.repeat(32))},'owner:google',a));
});
test('OAuth has PKCE and read-only scope; state binds to session/account, expires and cannot replay',async t=>{
 const f=await fixture(t);google(t);
 const url=new URL(await app.beginGoogleAuthorization(f.env,'owner',f.request('/api/import/gmail/connect',{})));
 assert.equal(url.searchParams.get('scope'),app.GMAIL_SCOPE);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');
 const callback='/api/import/gmail/callback?state='+url.searchParams.get('state')+'&code=test-code';
 await assert.rejects(app.completeGoogleAuthorization(f.env,'other',f.request(callback,undefined,'other')));
 const changed=await app.createSession(f.env,'owner');await assert.rejects(app.completeGoogleAuthorization(f.env,'owner',new Request('https://mailflare.test'+callback,{headers:{Authorization:'Bearer '+changed}})));
 const connection=await app.completeGoogleAuthorization(f.env,'owner',f.request(callback));assert.equal(connection.email,'owner@workspace.test');
 await assert.rejects(app.completeGoogleAuthorization(f.env,'owner',f.request(callback)));
 const row=f.DB.db.prepare('SELECT tokens FROM gmail_import_connections').get();assert(!row.tokens.includes('new-access'));
 const expired=new URL(await app.beginGoogleAuthorization(f.env,'owner',f.request('/api/import/gmail/connect',{})));f.DB.db.exec('UPDATE gmail_oauth_states SET expires_at=0');
 await assert.rejects(app.completeGoogleAuthorization(f.env,'owner',f.request('/api/import/gmail/callback?state='+expired.searchParams.get('state')+'&code=x')));
});
test('anonymous calls and cross-site cookie writes fail; API returns no tokens or cursors',async t=>{
 const f=await fixture(t);await addConnection(f);
 assert.equal((await app.status(f.request('/api/import/gmail',undefined,'anon'))).status,401);
 assert.equal((await app.connect(f.request('/api/import/gmail/connect',{},'anon'))).status,401);
 globalThis.__gmailTestCookie=f.tokens.owner;
 assert.equal((await app.connect(new Request('https://mailflare.test/api/import/gmail/connect',{method:'POST',headers:{Cookie:'ep_session='+f.tokens.owner,Origin:'https://attacker.test'},body:'{}'}))).status,403);
 const response=await app.status(f.request());assert.equal(response.headers.get('Cache-Control'),'private, no-store');const info=await response.json();assert.equal(info.connections[0].email,'owner@workspace.test');assert(!JSON.stringify(info).includes('tokens'));assert(!JSON.stringify(info).includes('test-secret'));
 assert.equal((await app.create(f.request('/api/import/gmail/jobs',{connectionId:'google',mailboxId:'foreign'}))).status,400);
 assert.equal((await app.create(f.request('/api/import/gmail/jobs',{connectionId:'google',mailboxId:'box'},'other'))).status,400);
});
test('paged import preserves labels, categories, read/star state, sent/drafts, original dates and attachments',async t=>{
 const f=await fixture(t);await addConnection(f);const remote=google(t);let job=await app.createGmailJob(f.env,f.user,'google','box');
 job=await app.advanceGmailJob(f.env,f.user,job.id);assert.equal(job.processed,3);assert.equal(job.status,'paused');
 for(let i=0;i<8&&job.status!=='completed';i++)job=await app.advanceGmailJob(f.env,f.user,job.id);
 assert.equal(job.status,'completed');assert.equal(job.imported,8);assert.equal(job.processed,8);assert.equal(job.total,8);
 const rows=f.DB.db.prepare('SELECT * FROM messages ORDER BY subject').all(),one=rows.find(x=>x.subject==='Gmail one');
 assert.equal(one.read,1);assert.equal(one.starred,1);assert.equal(one.bcc_addr,'secret@example.test');assert.equal(one.created_at,1735732800);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels WHERE message_id=?').get(one.id).n,2);
 assert.equal(rows.find(x=>x.subject==='Gmail two').direction,'outbound');assert.equal(rows.find(x=>x.subject==='Gmail two').read,0);
 assert.equal(one.thread_id,rows.find(x=>x.subject==='Gmail two').thread_id);
 assert.equal(rows.find(x=>x.subject==='Gmail three').status,'draft');assert.equal(rows.find(x=>x.subject==='Gmail four').status,'spam');assert.equal(rows.find(x=>x.subject==='Gmail five').status,'trash');
 assert.equal(rows.find(x=>x.subject==='Gmail six').category,'promotions');assert.equal(rows.find(x=>x.subject==='Gmail seven').category,'social');assert.equal(rows.find(x=>x.subject==='Gmail eight').status,'archived');
 const attachment=f.DB.db.prepare('SELECT * FROM message_attachments WHERE message_id=?').get(one.id);assert.equal(attachment.filename,'test.pdf');assert.equal(new TextDecoder().decode(f.objects.get(attachment.r2_key)),'pdf');
 assert(remote.calls.every(c=>c.method==='GET'));assert.equal(remote.calls.filter(c=>c.path.endsWith('/messages')).length,2);
 const again=await app.createGmailJob(f.env,f.user,'google','box');await app.advanceGmailJob(f.env,f.user,again.id);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,8);
});
test('failed messages retain checkpoints; resuming does not lose mail or duplicate completed messages',async t=>{
 const f=await fixture(t);await addConnection(f);const remote=google(t,{failId:'two'});let job=await app.createGmailJob(f.env,f.user,'google','box');
 job=await app.advanceGmailJob(f.env,f.user,job.id);assert.equal(job.status,'failed');assert.equal(job.processed,1);assert.equal(JSON.parse(job.cursor).pending[0],'two');
 remote.fix();for(let i=0;i<8&&job.status!=='completed';i++)job=await app.advanceGmailJob(f.env,f.user,job.id);
 assert.equal(job.imported,8);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,8);
});
test('large label sets stay within D1 parameter limits and deleted labels do not strand the import',async t=>{
 const f=await fixture(t);await addConnection(f);google(t,{ids:['one'],extraLabels:80});
 const prepare=f.DB.prepare.bind(f.DB);t.mock.method(f.DB,'prepare',sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...args)=>{assert(args.length<=100,'D1 bound parameter limit');return bind(...args);};return statement;});
 let job=await app.createGmailJob(f.env,f.user,'google','box');f.DB.db.exec("DELETE FROM folders WHERE name='Work'");
 job=await app.advanceGmailJob(f.env,f.user,job.id);assert.equal(job.status,'completed');assert.equal(job.imported,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,81);
});
test('oversized mail pauses before raw download; explicit skip resumes the remaining messages',async t=>{
 const f=await fixture(t);await addConnection(f);const remote=google(t,{largeId:'one'});let job=await app.createGmailJob(f.env,f.user,'google','box');
 await assert.rejects(app.skipGmailMessage(f.env,f.user,job.id),/interrupted/);
 job=await app.advanceGmailJob(f.env,f.user,job.id);assert.equal(job.status,'failed');assert.equal(job.processed,0);assert(app.publicGmailJob(job).canSkip);assert.equal(remote.calls.filter(c=>c.path.endsWith('/one')).length,1,'raw content was not downloaded');
 job=await app.skipGmailMessage(f.env,f.user,job.id);assert.equal(job.skipped,1);
 for(let i=0;i<8&&job.status!=='completed';i++)job=await app.advanceGmailJob(f.env,f.user,job.id);
 assert.equal(job.imported,7);assert.equal(job.processed,8);assert.equal(job.skipped,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,7);
});
test('Google must grant offline read access; missing scope/refresh tokens are rejected',async t=>{
 const f=await fixture(t);
 let scope='https://www.googleapis.com/auth/gmail.modify',refresh='refresh';
 t.mock.method(globalThis,'fetch',async()=>Response.json({access_token:'access',expires_in:3600,scope,refresh_token:refresh}));
 for(let attempt=0;attempt<2;attempt++){
  const start=new URL(await app.beginGoogleAuthorization(f.env,'owner',f.request('/api/import/gmail/connect',{})));
  await assert.rejects(app.completeGoogleAuthorization(f.env,'owner',f.request('/api/import/gmail/callback?code=x&state='+start.searchParams.get('state'))),/offline Gmail read/);
  scope=app.GMAIL_SCOPE;refresh=undefined;
 }
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM gmail_import_connections').get().n,0);
});
test('concurrent starts share one active job and concurrent batches are serialized',async t=>{
 const f=await fixture(t);await addConnection(f);const remote=google(t,{holdId:'one'});
	const previous=await app.createGmailJob(f.env,f.user,'google','box');f.DB.db.prepare("UPDATE gmail_import_jobs SET status='completed' WHERE id=?").run(previous.id);
 const [a,b]=await Promise.all([app.createGmailJob(f.env,f.user,'google','box'),app.createGmailJob(f.env,f.user,'google','box')]);assert.equal(a.id,b.id);
 const pending=app.advanceGmailJob(f.env,f.user,a.id);for(let i=0;i<100&&!remote.held();i++)await new Promise(r=>setTimeout(r,5));assert(remote.held());
 await assert.rejects(app.advanceGmailJob(f.env,f.user,a.id),/already running/);remote.release();assert.equal((await pending).processed,3);
});
test('expired tokens refresh without exposing credentials; revoked mailbox permissions block resumption',async t=>{
 const f=await fixture(t);await addConnection(f,true);const remote=google(t);const job=await app.createGmailJob(f.env,f.user,'google','box');assert(remote.calls.some(c=>c.path==='/token'&&c.method==='POST'));
 await assert.rejects(app.advanceGmailJob(f.env,{...f.user,id:'other'},job.id),/not found/);
	f.DB.db.exec("UPDATE mailboxes SET user_id='other' WHERE id='box'");await assert.rejects(app.advanceGmailJob(f.env,f.user,job.id),/permission changed/);
 const token=f.DB.db.prepare('SELECT tokens FROM gmail_import_connections').get().tokens;assert.equal((await app.decryptGoogleTokens(f.env,'owner:google',token)).access_token,'new-access');
});
test('disconnecting before an in-flight message writes cancels the job and keeps already imported messages',async t=>{
 const f=await fixture(t);await addConnection(f);const remote=google(t,{holdId:'one'}),job=await app.createGmailJob(f.env,f.user,'google','box');
 const pending=app.advanceGmailJob(f.env,f.user,job.id);for(let i=0;i<100&&!remote.held();i++)await new Promise(r=>setTimeout(r,5));assert(remote.held());
 await app.disconnect(new Request('https://mailflare.test/api/import/gmail/connections/google',{method:'DELETE',headers:{Authorization:'Bearer '+f.tokens.owner}}),{params:Promise.resolve({id:'google'})});remote.release();await assert.rejects(pending,/not found/);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,0);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM gmail_import_jobs').get().n,0);
});
test('backups before/after migration preserve encrypted connections and checkpoints; OAuth states and leases do not resume',async t=>{
 const f=await fixture(t,true);const old=await app.exportDatabaseRecords(f.DB);await app.restoreDatabaseRecords(f.DB,old.buffer);
 await app.applyMigrations(f.DB,join(process.cwd(),'drizzle/migrations'));await app.restoreDatabaseRecords(f.DB,old.buffer);f.user=await app.getUserFromSession(f.env,f.tokens.owner);await addConnection(f);google(t);
 const job=await app.createGmailJob(f.env,f.user,'google','box');await app.beginGoogleAuthorization(f.env,'owner',f.request('/api/import/gmail/connect',{}));
 f.DB.db.prepare("UPDATE gmail_import_jobs SET status='running',lease_token='stale',lease_until=? WHERE id=?").run(Date.now()+3600000,job.id);
 const backup=await app.exportDatabaseRecords(f.DB),doc=JSON.parse(new TextDecoder().decode(backup));assert(!('gmail_oauth_states' in doc.tables));assert.equal(doc.tables.gmail_import_connections.length,1);assert.equal(doc.tables.gmail_import_jobs.length,1);
 await app.restoreDatabaseRecords(f.DB,backup.buffer);const restored=f.DB.db.prepare('SELECT * FROM gmail_import_jobs').get();assert.equal(restored.status,'paused');assert.equal(restored.lease_token,null);assert.equal(restored.lease_until,0);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM gmail_oauth_states').get().n,0);
 assert.equal((await app.decryptGoogleTokens(f.env,'owner:google',f.DB.db.prepare('SELECT tokens FROM gmail_import_connections').get().tokens)).refresh_token,'refresh-test');
});

test('OAuth returns to the expanded Gmail settings section after success or failure',async t=>{
 const f=await fixture(t);google(t);
 const start=new URL(await app.beginGoogleAuthorization(f.env,'owner',f.request('/api/import/gmail/connect',{})));
 const response=await app.callback(f.request('/api/import/gmail/callback?state='+start.searchParams.get('state')+'&code=test-code'));
 assert.equal(response.status,303);const target=new URL(response.headers.get('Location'));assert.equal(target.pathname,'/settings/import');assert.equal(target.hash,'#gmail-import');assert.equal(target.searchParams.get('gmail'),'connected');assert(target.searchParams.get('googleConnection'));assert(!target.href.includes('test-code'));assert.equal(response.headers.get('Cache-Control'),'private, no-store');
 const failed=await app.callback(f.request('/api/import/gmail/callback?error=access_denied'));assert.equal(new URL(failed.headers.get('Location')).hash,'#gmail-import');assert.equal(new URL(failed.headers.get('Location')).searchParams.get('gmail'),'error');
});
