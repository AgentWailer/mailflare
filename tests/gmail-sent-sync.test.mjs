import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','gmail-sent-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),"export async function cookies(){return {get:name=>name==='ep_session'&&globalThis.__gmailTestCookie?{value:globalThis.__gmailTestCookie}:undefined};}");
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';
 export {createSession,getUserFromSession} from './src/lib/auth/session';export {encryptGoogleTokens} from './src/lib/import/gmail-oauth';
 export * from './src/lib/import/gmail-sent-sync';export {GET as status} from './src/app/api/import/gmail/route';export {POST as control} from './src/app/api/import/gmail/sent-sync/route';
 export {DELETE as disconnect} from './src/app/api/import/gmail/connections/[id]/route';export {createGmailJob,advanceGmailJob} from './src/lib/import/gmail-jobs';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,'drizzle/migrations');
 t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__gmailTestCookie;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('foreign','other','domain','other','personal',1);`);
 const objects=new Map(),queued=[];
 const env={DB,MAILFLARE_RUNTIME:'node',GMAIL_OAUTH_CLIENT_ID:'test-client',GMAIL_OAUTH_CLIENT_SECRET:'test-secret',GMAIL_OAUTH_REDIRECT_URI:'https://mailflare.test/api/import/gmail/callback',GMAIL_IMPORT_ENCRYPTION_KEY:btoa('k'.repeat(32)),AGENT_QUEUE:{send:async body=>queued.push(body)},BUCKET:{put:async(k,v)=>objects.set(k,v),delete:async k=>{for(const key of Array.isArray(k)?k:[k])objects.delete(key);}}};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const user of ['owner','other'])tokens[user]=await app.createSession(env,user);
 const user=await app.getUserFromSession(env,tokens.owner);
 const encrypted=await app.encryptGoogleTokens(env,'owner:google',{access_token:'access',refresh_token:'refresh',expiresAt:Date.now()+3600000});
 DB.db.prepare("INSERT INTO gmail_import_connections(id,user_id,email,tokens,created_at) VALUES('google','owner','owner@workspace.test',?,1)").run(encrypted);
 const request=(body,actor='owner')=>new Request('https://mailflare.test/api/import/gmail/sent-sync',{method:'POST',headers:{Authorization:'Bearer '+tokens[actor],'Content-Type':'application/json'},body:JSON.stringify({connectionId:'google',mailboxId:'box',...body})});
 const job=()=>DB.db.prepare('SELECT * FROM gmail_sent_sync').get();
 const enable=()=>app.controlGmailSentSync(env,user,{connectionId:'google',mailboxId:'box',action:'enable'});
 async function drain(){for(let i=0;i<30&&queued.length;i++){const body=queued.shift();assert.equal(body.kind,'gmail.sent-sync');await app.processGmailSentSync(env,body.connectionId);}assert.equal(queued.length,0,'bounded test queue drain');}
 return {DB,env,objects,queued,tokens,user,request,job,enable,drain};
}
const raw=id=>Buffer.from(`From: Owner <owner@workspace.test>\r\nTo: Recipient <recipient@example.test>\r\nCc: cc@example.test\r\nBcc: secret@example.test\r\nMessage-ID: <gmail-${id}@example.test>\r\nDate: Wed, 1 Jan 2025 12:00:00 +0000\r\nSubject: Sent ${id}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nHello\r\n--part\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="receipt.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\ncGRm\r\n--part--`);
function google(t,{ids=['one','two','three','four'],history=[]}={}){
 const calls=[],state={ids,history,failId:null,largeId:null,expired:false,revoked:false,quota:false,hold:null,release:null,anchor:'9007199254740993000',frontier:'9007199254740993999'};
 t.mock.method(globalThis,'fetch',async(input,options={})=>{
  const url=new URL(input);calls.push(url);assert(!options.method || options.method==='GET','no Google writes');
  if(!url.hostname.endsWith('googleapis.com'))return new Response(null,{status:404});
  if(state.quota)return Response.json({error:{errors:[{reason:'userRateLimitExceeded'}]}},{status:403});
  if(state.revoked)return new Response(null,{status:403});
  if(url.pathname.endsWith('/profile'))return Response.json({historyId:state.anchor});
  if(url.pathname.endsWith('/messages')){
   assert.equal(url.searchParams.get('labelIds'),'SENT');assert.equal(url.searchParams.get('includeSpamTrash'),'false');assert(!url.searchParams.get('q')?.includes('in:anywhere'));
   const offset=url.searchParams.get('pageToken')==='page2'?2:0;
   return Response.json({messages:state.ids.slice(offset,offset+2).map(id=>({id})),...(offset===0&&state.ids.length>2?{nextPageToken:'page2'}:{})});
  }
  if(url.pathname.endsWith('/history')){
   if(state.expired){state.expired=false;return new Response(null,{status:404});}
   assert.equal(url.searchParams.get('labelId'),'SENT');assert(url.searchParams.getAll('historyTypes').includes('labelAdded'));
   return Response.json({historyId:state.frontier,history:state.history});
  }
  const id=url.pathname.split('/').at(-1);if(state.hold===id)await new Promise(resolve=>state.release=resolve);
  if(id===state.failId)return new Response(null,{status:429});
  const labelIds=id==='not-sent'?['INBOX']:id==='trashed'?['SENT','TRASH']:['SENT','STARRED'];
  if(url.searchParams.get('format')==='metadata')return Response.json({id,labelIds,sizeEstimate:state.largeId===id?41*1024*1024:raw(id).length,payload:{headers:[{name:'Message-ID',value:`<gmail-${id}@example.test>`}]}});
  assert.equal(url.searchParams.get('format'),'raw');return Response.json({id,labelIds,raw:raw(id).toString('base64url'),threadId:'conversation',internalDate:'1735732800000'});
 });return {calls,state};
}
test('sent-only paginated backfill runs from durable server jobs and copies MIME, recipients, dates and attachments',async t=>{
 const f=await fixture(t),g=google(t);await f.enable();assert.equal(f.queued.length,1);await f.drain();
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,4);assert.equal(f.job().imported,4);assert.equal(f.job().history_id,g.state.frontier);assert.equal(f.job().lease_token,null);assert(f.job().last_synced_at);assert(f.job().retry_at>Date.now());
 const first=f.DB.db.prepare("SELECT * FROM messages WHERE subject='Sent one'").get();assert.equal(first.status,'sent');assert.equal(first.direction,'outbound');assert.equal(first.read,1);assert.equal(first.starred,1);assert.equal(first.user_id,'owner');assert.equal(first.created_at,1735732800);assert(first.bcc_addr.includes('secret@example.test'));assert.equal(first.thread_id,'gmail:owner@workspace.test:conversation');
 const attachment=f.DB.db.prepare('SELECT * FROM message_attachments WHERE message_id=?').get(first.id);assert.equal(attachment.filename,'receipt.pdf');assert.equal(Buffer.from(f.objects.get(attachment.r2_key)).toString(),'pdf');
 assert(g.calls.filter(u=>u.pathname.endsWith('/history')).every(u=>u.searchParams.get('startHistoryId')===g.state.anchor),'history IDs retain full precision');
});
test('history imports only newly sent mail and MIME Message-ID skips duplicates before downloading content',async t=>{
 const f=await fixture(t),g=google(t,{ids:['one']});await f.enable();await f.drain();const first=f.DB.db.prepare('SELECT * FROM messages').get();f.DB.db.prepare("UPDATE messages SET status='trash',starred=0 WHERE id=?").run(first.id);
 const before=g.calls.length;g.state.history=[{messagesAdded:[{message:{id:'two'}},{message:{id:'not-sent',labelIds:['INBOX']}}],labelsAdded:[{message:{id:'one'},labelIds:['SENT']},{message:{id:'two'},labelIds:['SENT']},{message:{id:'trashed'},labelIds:['SENT']}]}];
 f.DB.db.exec('UPDATE gmail_sent_sync SET retry_at=0');await app.recoverGmailSentSync(f.env);await f.drain();const calls=g.calls.slice(before);
 assert(!calls.some(u=>u.pathname.endsWith('/messages')),'incremental sync never scans all mail');assert(!calls.some(u=>u.pathname.endsWith('/one')&&u.searchParams.get('format')==='raw'));assert(!calls.some(u=>u.pathname.endsWith('/not-sent')));assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,2);assert.equal(f.DB.db.prepare('SELECT status FROM messages WHERE id=?').get(first.id).status,'trash');
});
test('rate limits retain the pending message and retry without an open app; bad large mail is logged without blocking later sends',async t=>{
 const f=await fixture(t),g=google(t,{ids:['one','two']});g.state.failId='one';await f.enable();await f.drain();assert.equal(f.job().error,'temporary_failure');assert.equal(f.job().enabled,1);assert.equal(JSON.parse(f.job().cursor).pending[0],'one');assert.equal(f.job().imported,0);
 g.state.failId=null;g.state.largeId='one';f.DB.db.exec('UPDATE gmail_sent_sync SET retry_at=0');await app.recoverGmailSentSync(f.env);await f.drain();assert.equal(f.job().imported,1);assert.equal(f.DB.db.prepare('SELECT error FROM gmail_sent_sync_issues').get().error,'message_too_large');assert(!g.calls.some(u=>u.pathname.endsWith('/one')&&u.searchParams.get('format')==='raw'));
 const before=g.calls.length;g.state.largeId=null;await app.controlGmailSentSync(f.env,f.user,{connectionId:'google',mailboxId:'box',action:'retry',sourceId:'one'});await f.drain();assert.equal(f.job().imported,2);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM gmail_sent_sync_issues').get().n,0);assert(!g.calls.slice(before).some(u=>u.pathname.endsWith('/messages')),'retry is limited to the selected failed message');
});
test('expired history falls back to a sent-only scan and does not duplicate or re-download existing mail',async t=>{
 const f=await fixture(t),g=google(t,{ids:['one']});await f.enable();await f.drain();const before=g.calls.length;g.state.expired=true;f.DB.db.exec('UPDATE gmail_sent_sync SET retry_at=0');await app.recoverGmailSentSync(f.env);await f.drain();assert.equal(f.job().imported,1);assert(!g.calls.slice(before).some(u=>u.searchParams.get('format')==='raw'));assert.equal(f.job().error,null);
});
test('leases serialize workers and pausing during a fetch cancels publication and removes the staged message',async t=>{
 const f=await fixture(t),g=google(t,{ids:['one']});await f.enable();f.queued.length=0;
 let release,held=false;const put=f.env.BUCKET.put;f.env.BUCKET.put=async(...args)=>{if(!held){held=true;await new Promise(r=>release=r);}return put(...args);};
 const running=app.processGmailSentSync(f.env,'google');for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,5));assert(held);assert.equal(f.DB.db.prepare('SELECT status FROM messages').get().status,'importing');const calls=g.calls.length;
 await app.processGmailSentSync(f.env,'google');assert.equal(g.calls.length,calls,'duplicate queue delivery cannot claim the lease');
 await app.controlGmailSentSync(f.env,f.user,{connectionId:'google',mailboxId:'box',action:'pause'});release();await running;assert.equal(f.job().enabled,0);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,0);assert.equal(f.objects.size,0);
 f.env.BUCKET.put=put;await f.enable();await f.drain();assert.equal(f.job().imported,1);
});
test('disabled accounts and revoked Google grants stop background access, while session, origin and mailbox guards protect configuration',async t=>{
 const f=await fixture(t),g=google(t,{ids:['one']});
 assert.equal((await app.control(f.request({action:'enable'},'missing'))).status,401);assert.equal((await app.control(f.request({action:'enable'},'other'))).status,400);assert.equal((await app.control(f.request({action:'enable',mailboxId:'foreign'}))).status,400);
 globalThis.__gmailTestCookie=f.tokens.owner;assert.equal((await app.control(new Request('https://mailflare.test/api/import/gmail/sent-sync',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.test'},body:JSON.stringify({connectionId:'google',mailboxId:'box',action:'enable'})}))).status,403);delete globalThis.__gmailTestCookie;
 await f.enable();f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");await f.drain();assert.equal(g.calls.length,0);assert.equal(f.job().enabled,0);assert.equal(f.job().error,'permission_changed');
 f.DB.db.exec("UPDATE users SET disabled=0 WHERE id='owner'");await f.enable();g.state.revoked=true;await f.drain();assert.equal(f.job().enabled,0);assert.equal(f.job().error,'google_authorization');
 const status=await (await app.status(new Request('https://mailflare.test/api/import/gmail',{headers:{Authorization:'Bearer '+f.tokens.owner}}))).json();assert.equal(status.sentSyncs.length,1);assert(!JSON.stringify(status).includes('refresh'));assert(!('cursor' in status.sentSyncs[0]));
});
test('snapshot imports and sent sync cannot hold overlapping leases for the same destination',async t=>{
 const f=await fixture(t),g=google(t,{ids:['one']});await f.enable();f.queued.length=0;
 // Seed a snapshot job directly; its live lease excludes background sync.
 f.DB.db.prepare("INSERT INTO gmail_import_jobs(id,user_id,mailbox_id,connection_id,lease_token,lease_until,created_at,updated_at) VALUES('snapshot','owner','box','google','snapshot-lease',?,1,1)").run(Date.now()+300000);
 await app.processGmailSentSync(f.env,'google');assert.equal(g.calls.length,0);
 f.DB.db.exec('UPDATE gmail_import_jobs SET lease_token=NULL,lease_until=0');f.DB.db.prepare("UPDATE gmail_sent_sync SET lease_token='sync-lease',lease_until=?").run(Date.now()+300000);
 await assert.rejects(app.advanceGmailJob(f.env,f.user,'snapshot'),/already running/);assert.equal(g.calls.length,0);
});
test('backup/restore retains checkpoints and issue logs but clears leases and requires explicit reactivation; disconnect retains sent mail',async t=>{
 const f=await fixture(t);google(t,{ids:['one']});await f.enable();await f.drain();f.DB.db.exec("UPDATE gmail_sent_sync SET lease_token='old',lease_until=9999999999999;INSERT INTO gmail_sent_sync_issues VALUES('google','problem','invalid_message',1)");
 const bytes=await app.exportDatabaseRecords(f.DB);await app.restoreDatabaseRecords(f.DB,bytes.buffer);assert.equal(f.job().enabled,0);assert.equal(f.job().lease_token,null);assert.equal(f.job().error,'restore_requires_review');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM gmail_sent_sync_issues').get().n,1);
 const response=await app.disconnect(new Request('https://mailflare.test/api/import/gmail/connections/google',{method:'DELETE',headers:{Authorization:'Bearer '+f.tokens.owner}}),{params:Promise.resolve({id:'google'})});assert.equal(response.status,200);assert.equal(f.job(),undefined);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM gmail_sent_sync_issues').get().n,0);
});


test('Google HTTP 403 quota errors back off without revoking the connection',async t=>{
 const f=await fixture(t),g=google(t,{ids:['one']});g.state.quota=true;await f.enable();await f.drain();assert.equal(f.job().enabled,1);assert.equal(f.job().error,'temporary_failure');assert(f.job().retry_at>Date.now());g.state.quota=false;f.DB.db.exec('UPDATE gmail_sent_sync SET retry_at=0');await app.recoverGmailSentSync(f.env);await f.drain();assert.equal(f.job().imported,1);
});
