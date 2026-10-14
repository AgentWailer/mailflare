import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','paperless-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`export {getDb} from './src/db';export {emailSet} from './src/lib/jmap/emails';export {encodeMailboxRef} from './src/lib/jmap/ids';export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createSession} from './src/lib/auth/session';export {GET,POST} from './src/app/api/settings/paperless/route';export * from './src/lib/paperless/client';export * from './src/lib/paperless/jobs';export {executeOrganizationAction} from './src/lib/messages/organize-action';export {executeBulkMessageAction} from './src/lib/messages/bulk-action';export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const task='12345678-1234-1234-1234-123456789abc';
async function fixture(t,{beforeMigration=false}={}){
 const DB=new app.SqliteDatabase(':memory:');const originalFetch=globalThis.fetch;t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;globalThis.fetch=originalFetch;});
 if(beforeMigration){const tmp=join(dir,'old-'+Math.random());await import('node:fs').then(fs=>{fs.mkdirSync(tmp);for(const file of fs.readdirSync('drizzle/migrations').filter(f=>f.endsWith('.sql')&&f<'0077'))fs.copyFileSync(join('drizzle/migrations',file),join(tmp,file));});await app.applyMigrations(DB,tmp);}else await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@test.invalid','hash','Owner','user',1),('other','other@test.invalid','hash','Other','user',1),('reader','reader@test.invalid','hash','Reader','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','test.invalid','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','shared',1),('otherbox','other','domain','other','personal',1);
 INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('grant','reader','box','read_only',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('paper','owner','box','Paperless',1),('processed','owner','box','Verarbeitet',1),('otherlabel','other','otherbox','Foreign',1);UPDATE folders SET parent_id='paper' WHERE id='processed';`);
 const files=new Map(),queued=[],calls=[];
 const env={DB,MAILFLARE_RUNTIME:'node',PAPERLESS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),AGENT_QUEUE:{send:async(body,options)=>queued.push({body,options})},BUCKET:{get:async(key,options)=>{const full=files.get(key);if(!full)return null;const bytes=options?.range?full.slice(options.range.offset,options.range.offset+options.range.length):full;return {size:bytes.length,body:new Blob([bytes]).stream(),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}}};globalThis.__mailflareNodeEnv=env;
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json(String(url).includes('post_document')?task:[]);};
 const tokens={};for(const id of ['owner','reader','other'])tokens[id]=await app.createSession(env,id);
 const request=(body,user='owner',query='mailboxId=box')=>new Request('https://mailflare.test/api/settings/paperless?'+query,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens[user],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const user={...DB.db.prepare("SELECT * FROM users WHERE id='owner'").get(),id:'owner',role:'user'};
 async function save(extra={}){const r=await app.POST(request({action:'save',mailboxId:'box',baseUrl:'https://dms.example.test',token:'a-secret-token',enabled:true,labelId:'paper',processedLabelId:'processed',...extra}));assert.equal(r.status,200,await r.clone().text());}
 function add(id,{mailbox='box',status='received',labels=[],pdfs=1}={}){DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,created_at) VALUES(?,?,?,'inbound','sender@test.invalid','owner@test.invalid','Invoice',?,1)").run(id,mailbox==='box'?'owner':'other',mailbox,status);for(const label of labels)DB.db.prepare('INSERT INTO message_labels VALUES(?,?)').run(id,label);for(let i=0;i<pdfs;i++){const a=id+'-pdf-'+i,key='attachments/'+a;DB.db.prepare("INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES(?,?,'receipt.pdf','application/pdf',20,?,1)").run(a,id,key);files.set(key,new TextEncoder().encode('%PDF-1.7\nInvoice data'));}}
 async function tag(id,ids=['paper']){const r=await app.executeOrganizationAction(env,user,{mailboxId:'box',messageIds:[id],addLabelIds:ids});assert.equal(r.status,200,await r.clone().text());}
 const jobs=()=>DB.db.prepare('SELECT * FROM paperless_jobs ORDER BY attachment_id').all();
 const run=async(id=jobs()[0].id)=>{DB.db.prepare('UPDATE paperless_jobs SET retry_at=0 WHERE id=?').run(id);await app.processPaperlessJob(env,id);};
 return {DB,env,files,queued,calls,request,save,add,tag,jobs,run,user};
}
test('settings encrypt credentials, never return them, and do not export old labeled mail',async t=>{
 const f=await fixture(t);f.add('old',{labels:['paper']});await f.save();assert.equal(f.jobs().length,0);
 const c=await app.loadConnection(f.env,'box');assert(!c.credentials.includes('a-secret-token'));
 const state=await (await app.GET(f.request())).json();assert.equal(state.connection.hasToken,true);assert(!JSON.stringify(state).includes('a-secret-token'));assert.equal(f.calls.length,2);
 assert.equal((await app.decryptCredentials(f.env,'box',c.base_url,c.credentials)).token,'a-secret-token');
 await assert.rejects(()=>app.decryptCredentials(f.env,'otherbox',c.base_url,c.credentials),/reconnect_required/);
 await assert.rejects(()=>app.decryptCredentials(f.env,'box','https://other.test',c.credentials),/reconnect_required/);
});
test('tagging multiple PDFs queues once; completion labels only after every task succeeds',async t=>{
 const f=await fixture(t);await f.save();f.add('mail',{pdfs:2});await f.tag('mail');await f.tag('mail');assert.equal(f.jobs().length,2);
 const before=f.DB.db.prepare("SELECT status,read FROM messages WHERE id='mail'").get();
 await f.run();assert.equal(f.jobs()[0].status,'waiting');assert.equal(f.jobs()[0].task_id,task);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM message_labels WHERE folder_id='processed'").get().n,0);
 globalThis.fetch=async(url,init)=>{f.calls.push({url,init});return Response.json(String(url).includes('post_document')?task:[{task_id:task,status:'SUCCESS',related_document:42}]);};
 await f.run();assert.equal(f.jobs()[0].status,'completed');assert.equal(f.DB.db.prepare("SELECT count(*) n FROM message_labels WHERE folder_id='processed'").get().n,0);
 await f.run(f.jobs()[1].id);await f.run(f.jobs()[1].id);assert.equal(f.DB.db.prepare("SELECT count(*) n FROM message_labels WHERE folder_id='processed'").get().n,1);assert.deepEqual(f.DB.db.prepare("SELECT status,read FROM messages WHERE id='mail'").get(),before);
 const uploads=f.calls.filter(c=>c.url.includes('post_document'));assert.equal(uploads.length,2);
 const multipart=await new Response(uploads[0].init.body).text();assert.match(multipart,/%PDF-1.7/);assert.match(multipart,/name="document"; filename="receipt.pdf"/);assert.equal(uploads[0].init.redirect,'manual');assert.equal(uploads[0].init.headers.Accept,'application/json');
 await f.tag('mail');assert.equal(f.jobs().length,2);
});
test('completed old Paperless documents, non-PDFs and trash do not upload',async t=>{
 const f=await fixture(t);await f.save();f.add('done',{labels:['paper','processed']});await f.tag('done');f.add('trash',{status:'trash'});await f.tag('trash');f.add('text',{pdfs:0});f.DB.db.exec("INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES('txt','text','note.txt','text/plain',5,'text',1)");await f.tag('text');assert.equal(f.jobs().length,0);
});
test('invalid PDF fails independently and retains labels without claiming completion',async t=>{
 const f=await fixture(t);await f.save();f.add('mail',{pdfs:2});f.files.set('attachments/mail-pdf-0',new TextEncoder().encode('<html>Not a PDF</html>'));await f.tag('mail');await f.run();assert.equal(f.jobs()[0].error,'invalid_pdf');assert.equal(f.jobs()[0].status,'failed');await f.run(f.jobs()[1].id);assert.equal(f.jobs()[1].status,'waiting');assert.equal(f.calls.filter(c=>c.url.includes('post_document')).length,1);
});
test('ambiguous upload does not auto-repeat; explicit retry requires acknowledgement',async t=>{
 const f=await fixture(t);await f.save();f.add('mail');await f.tag('mail');globalThis.fetch=async()=>{throw Error('timeout secret payload');};await f.run();let job=f.jobs()[0];assert.equal(job.status,'uncertain');assert.equal(job.error,'upload_uncertain');await app.recoverPaperlessJobs(f.env);assert.equal(f.queued.length,1);await f.run();assert.equal(f.jobs()[0].status,'uncertain');
 const r=await app.POST(f.request({action:'retry',mailboxId:'box',jobId:job.id}));assert.equal(r.status,409);assert.equal(f.jobs()[0].status,'uncertain');
 assert.equal((await app.POST(f.request({action:'retry',mailboxId:'box',jobId:job.id,confirmUncertain:true}))).status,200);assert.equal(f.jobs()[0].status,'pending');
});
test('cron recovers durable outbox after enqueue failure and marks a crashed upload uncertain',async t=>{
 const f=await fixture(t);await f.save();f.add('mail',{pdfs:2});f.env.AGENT_QUEUE.send=async()=>{throw Error('queue down');};await f.tag('mail');assert.equal(f.jobs().length,2);f.env.AGENT_QUEUE.send=async body=>f.queued.push({body});
 f.DB.db.prepare("UPDATE paperless_jobs SET status='uploading',lease_until=1,lease_token='crashed' WHERE id=?").run(f.jobs()[0].id);await app.recoverPaperlessJobs(f.env);assert.equal(f.jobs()[0].status,'uncertain');assert.equal(f.queued.length,1);assert.equal(f.queued[0].body.jobId,f.jobs()[1].id);
});
test('pending task is polled without re-upload, and duplicate task failure requires review',async t=>{
 const f=await fixture(t);await f.save();f.add('mail');await f.tag('mail');await f.run();let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json([{task_id:task,status:'STARTED',related_document:null}]);};await f.run();assert.equal(f.jobs()[0].status,'waiting');
 globalThis.fetch=async()=>{calls++;return Response.json([{task_id:task,status:'FAILURE',result:'duplicate of document #5'}]);};await f.run();assert.equal(f.jobs()[0].status,'failed');assert.equal(f.jobs()[0].error,'processing_failed');assert.equal(calls,2);
 await app.POST(f.request({action:'retry',mailboxId:'box',jobId:f.jobs()[0].id}));assert.equal(f.jobs()[0].status,'waiting');assert.equal(f.jobs()[0].task_id,task);
});
test('disabling pauses jobs without contacting remote, revoked permission and removed labels stop jobs',async t=>{
 const f=await fixture(t);await f.save();f.add('mail');await f.tag('mail');const n=f.calls.length;globalThis.fetch=async()=>{throw Error('offline');};await f.save({enabled:false,token:undefined});assert.equal(f.calls.length,n);await f.run();assert.equal(f.jobs()[0].status,'paused');
 globalThis.fetch=async()=>Response.json([]);await f.save();assert.equal(f.jobs()[0].status,'pending');f.DB.db.exec("DELETE FROM message_labels WHERE message_id='mail'");await f.run();assert.equal(f.jobs()[0].status,'cancelled');
 f.add('second');await f.tag('second');f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");await f.run(f.jobs()[1].id);assert.equal(f.jobs()[1].error,'permission_revoked');
});
test('settings and jobs enforce owner permissions and mailbox isolation',async t=>{
 const f=await fixture(t);await f.save();f.add('mail');await f.tag('mail');
 for(const who of ['reader','other']){assert.equal((await app.GET(f.request(null,who))).status,404);assert.equal((await app.POST(f.request({action:'retry',mailboxId:'box',jobId:f.jobs()[0].id},who))).status,404);}
 const response=await app.POST(f.request({action:'save',mailboxId:'box',baseUrl:'https://dms.example.test',enabled:true,labelId:'otherlabel',processedLabelId:'processed'}));assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_label');
 const csrf=new Request('https://mailflare.test/api/settings/paperless',{method:'POST',headers:{Cookie:'session=x',Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'});assert.notEqual((await app.POST(csrf)).status,200);
});
test('redirects never leak tokens and URL change cannot reuse a previous token',async t=>{
 const f=await fixture(t);await f.save();
 let response=await app.POST(f.request({action:'save',mailboxId:'box',baseUrl:'https://new.example.test',enabled:true,labelId:'paper',processedLabelId:'processed'}));assert.equal((await response.json()).error,'token_required');
 globalThis.fetch=async()=>new Response(null,{status:302,headers:{Location:'https://login.example.test'}});
 response=await app.POST(f.request({action:'save',mailboxId:'box',baseUrl:'https://dms.example.test',enabled:true,labelId:'paper',processedLabelId:'processed',token:'secret'}));assert.equal((await response.json()).error,'redirect_blocked');
 for(const url of ['http://example.com','https://user:pass@example.com','https://127.0.0.1','https://localhost','https://example.com?token=x'])assert.throws(()=>app.normalizePaperlessUrl(url));
});
test('legacy folder move queues atomically and rejects foreign-mailbox moves',async t=>{
 const f=await fixture(t);await f.save();f.add('mail');f.add('other',{mailbox:'otherbox'});
 let r=await app.executeBulkMessageAction(f.env,f.user,{action:'folder',folderId:'paper',messageIds:['mail','other']});assert.equal(r.status,200);assert.equal(f.jobs().length,1);assert.equal(f.DB.db.prepare("SELECT folder_id FROM messages WHERE id='other'").get().folder_id,null);
});
test('backup restores credentials disabled and active exports paused; older backups remain restorable',async t=>{
 const f=await fixture(t);await f.save();f.add('mail');await f.tag('mail');await f.run();const bytes=await app.exportDatabaseRecords(f.DB);const document=JSON.parse(new TextDecoder().decode(bytes));assert.equal(document.tables.paperless_jobs.length,1);assert.equal(document.tables.paperless_connections.length,1);
 await app.restoreDatabaseRecords(f.DB,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));assert.equal((await app.loadConnection(f.env,'box')).enabled,0);assert.equal(f.jobs()[0].status,'paused');assert.equal(f.jobs()[0].error,'restore_requires_review');assert.equal(f.jobs()[0].lease_token,null);
 delete document.tables.paperless_jobs;delete document.tables.paperless_connections;document.includedTables=document.includedTables.filter(k=>!k.startsWith('paperless_'));const old=new TextEncoder().encode(JSON.stringify(document));await app.restoreDatabaseRecords(f.DB,old.buffer);assert.equal(f.jobs().length,0);
});
test('backup works before migration and refuses newer nonempty exports before deleting old data',async t=>{
 const f=await fixture(t,{beforeMigration:true});const bytes=await app.exportDatabaseRecords(f.DB);const document=JSON.parse(new TextDecoder().decode(bytes));assert.deepEqual(document.tables.paperless_jobs,[]);await app.restoreDatabaseRecords(f.DB,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));document.tables.paperless_connections=[{mailbox_id:'box'}];const altered=new TextEncoder().encode(JSON.stringify(document));await assert.rejects(()=>app.restoreDatabaseRecords(f.DB,altered.buffer),/pending database migrations/);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM users').get().n,3);
});
test('editing unrelated labels on old Paperless mail never starts an export',async t=>{
 const f=await fixture(t);f.add('old',{labels:['paper']});await f.save();f.DB.db.exec("INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('work','owner','box','Work',1)");await f.tag('old',['work']);assert.equal(f.jobs().length,0);
});
test('new Paperless task schema and Cloudflare Access service tokens are supported',async t=>{
 const f=await fixture(t);await f.save({accessId:'access-id',accessSecret:'access-secret'});const state=await (await app.GET(f.request())).json();assert.equal(state.connection.hasAccessCredentials,true);assert(!JSON.stringify(state).includes('access-secret'));f.add('mail');await f.tag('mail');await f.run();const upload=f.calls.find(c=>c.url.includes('post_document'));assert.equal(upload.init.headers['CF-Access-Client-Id'],'access-id');assert.equal(upload.init.headers['CF-Access-Client-Secret'],'access-secret');
 globalThis.fetch=async()=>Response.json({results:[{task_id:task,status:'success',related_document_ids:[88]}]});await f.run();assert.equal(f.jobs()[0].document_id,88);assert.equal(f.jobs()[0].status,'completed');
});
test('prefilled disabled connection accepts the first token and stopped destination jobs remain isolated',async t=>{
 const f=await fixture(t);f.DB.db.prepare("INSERT INTO paperless_connections(mailbox_id,user_id,base_url,credentials,enabled,label_id,processed_label_id,created_at,updated_at) VALUES('box','owner','https://dms.example.test','',0,'paper','processed',1,1)").run();assert.equal((await (await app.GET(f.request())).json()).connection.hasToken,false);await f.save();f.add('mail');await f.tag('mail');
 const r=await app.POST(f.request({action:'save',mailboxId:'box',baseUrl:'https://new.example.test',token:'new-token',enabled:true,labelId:'paper',processedLabelId:'processed'}));assert.equal((await r.json()).error,'destination_has_jobs');assert.equal(f.jobs()[0].base_url,'https://dms.example.test');
});
test('JMAP label changes commit the PDF outbox with read/status flags',async t=>{
 const f=await fixture(t);await f.save();f.add('mail');const inbox=app.encodeMailboxRef({kind:'role',mailboxId:'box',role:'inbox'}),paper=app.encodeMailboxRef({kind:'folder',mailboxId:'box',folderId:'paper'});
 const ctx={env:f.env,db:app.getDb(f.env),auth:{user:f.user,mailboxIds:['box']},accountId:'owner',origin:'https://mailflare.test',createdIds:{}};
 const response=await app.emailSet(ctx,{update:{mail:{mailboxIds:{[inbox]:true,[paper]:true},keywords:{$seen:true}}}});assert.equal(response.updated.mail,null);assert.equal(f.jobs().length,1);assert.equal(f.DB.db.prepare("SELECT read FROM messages WHERE id='mail'").get().read,1);
});
test('upload errors identify document permissions, token rejection and Cloudflare challenges without storing response bodies',async t=>{
 const f=await fixture(t);await f.save();
 for(const [id,status,body,headers,expected] of [
  ['permission',403,'Insufficient permissions',{},'document_permission_denied'],
  ['token',401,'{"detail":"Invalid token."}',{},'paperless_token_rejected'],
  ['waf',403,'<html>private challenge payload</html>',{'cf-mitigated':'challenge'},'cloudflare_challenge'],
  ['generic',403,'private upstream page',{},'unauthorized_403']
 ]){f.add(id);await f.tag(id);globalThis.fetch=async()=>new Response(body,{status,headers});await f.run('paperless_'+id+'-pdf-0');const job=f.jobs().find(j=>j.message_id===id);assert.equal(job.status,'failed');assert.equal(job.error,expected);assert.equal(job.task_id,null);}
});
