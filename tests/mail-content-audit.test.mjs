import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','content-audit-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database'; export {applyMigrations} from './server/runtime/migrate';
 export {createSession} from './src/lib/auth/session';
 export {processContentAudit,recoverContentAudits,reviewAuditIssue} from './src/lib/mail-sorting/audit-jobs';
 export {getSortingExamples} from './src/lib/mail-sorting/learning';
 export {resolveTransactionMail} from './src/lib/mail-sorting/routine';
 export {GET,POST} from './src/app/api/settings/mail-sorting/audit/route';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export';
 export {normalizeImportedLabel} from './src/lib/import/mbox-labels';
 export {reviewText,deterministicReview} from './src/lib/mail-sorting/content-review';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
function answers(category,p=.95){return {category:{type:'choice',choice:category,probabilities:Object.fromEntries(['primary','invoices','orders','promotions','social','spam'].map(k=>[k,k===category?p:(1-p)/5]))},inbox:{type:'noul',noul:category==='primary'?.95:.01},action:{type:'noul',noul:.01},security:{type:'noul',noul:.01}};}
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 const prepare=DB.prepare.bind(DB);DB.prepare=sql=>{const stmt=prepare(sql),bind=stmt.bind.bind(stmt);stmt.bind=(...args)=>{assert(args.length<=100);return bind(...args);};return stmt;};
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@test.invalid','hash','Owner','user',1),('other','other@test.invalid','hash','Other','user',1),('reader','reader@test.invalid','hash','Reader','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','test.invalid','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','shared',1),('otherbox','other','domain','other','personal',1);
 INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('grant','reader','box','read_only',1);`);
 const queued=[],calls=[];
 const env={DB,MAILFLARE_RUNTIME:'node',AGENT_QUEUE:{send:async body=>queued.push(body)},AI:{run:async(model,input)=>{calls.push(input);return {answers:answers('promotions'),usage:{input_tokens:200}};}}};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['owner','reader','other'])tokens[id]=await app.createSession(env,id);
 const request=(body,user='owner',query='mailboxId=box')=>new Request('https://mailflare.test/api/settings/mail-sorting/audit?'+query,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens[user],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const add=(id,{subject='A newsletter',text='Monthly product announcements.',category='primary',status='archived',decision=null,mailbox='box',sender='sender@test.invalid'}={})=>DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,snippet,status,category,sorting_decision,read,created_at) VALUES(?,?,?,'inbound',?,'owner@test.invalid',?,?,?,?,?,?,0,1)").run(id,mailbox==='box'?'owner':'other',mailbox,sender,subject,text,text,status,category,decision);
 const row=id=>DB.db.prepare('SELECT * FROM mail_content_audit_jobs WHERE id=?').get(id);
 const start=async()=>{const response=await app.POST(request({mailboxId:'box',action:'start'}));assert.equal(response.status,202,await response.clone().text());return (await response.json()).job;};
 const drain=async id=>{for(let i=0;i<100&&row(id).status!=='completed';i++){await app.processContentAudit(env,id);assert(!['waiting','failed','paused'].includes(row(id).status),JSON.stringify(row(id)));}assert.equal(row(id).status,'completed');};
 return {DB,env,queued,calls,request,add,row,start,drain};
}
test('all categories receive a bounded content pass; repairs preserve read, archive, labels, and manual choices',async t=>{
 const f=await fixture(t);for(let i=0;i<221;i++)f.add('receipt-'+i,{subject:'Ihre nächste Ratenzahlung-Rate wird in Kürze abgebucht',text:'Ihre Rate von 80,00 € wird automatisch abgebucht.',category:'promotions'});
 f.add('delivery',{subject:'Geliefert: Dein Buch',text:'Dein Paket wurde zugestellt. Bestellnr. 306-111-222',category:'primary'});
 f.add('security',{subject:'Sicherheitswarnung',text:'Neue Anmeldung auf Apple iPhone',category:'social'});
 f.add('manual',{subject:'Ihre Rechnung',category:'promotions',decision:JSON.stringify({source:'manual',reason:'user_correction'})});
 f.add('explicit-rule',{subject:'Ihre Rechnung',category:'promotions',decision:JSON.stringify({source:'rule',reason:'existing_mail_filter',ruleId:'myrule'})});
 f.add('spam',{subject:'Ihre Rechnung',status:'spam'});f.add('foreign',{mailbox:'otherbox',subject:'Ihre Rechnung'});
 f.DB.db.exec("INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('work','owner','box','Work',1);INSERT INTO message_labels VALUES('receipt-0','work');UPDATE messages SET read=1 WHERE id='receipt-0'");
 const job=await f.start();assert.equal(job.total,225);assert.equal((await f.start()).id,job.id);f.add('new-arrival',{subject:'Ihre Rechnung'});
 await f.drain(job.id);assert.equal(f.row(job.id).processed,225);assert.equal(f.row(job.id).changed,223);assert.equal(f.row(job.id).review_count,2);assert.equal(f.calls.length,0);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages WHERE category='invoices'").get().n,221);
 const kept=f.DB.db.prepare("SELECT status,read FROM messages WHERE id='receipt-0'").get();assert.deepEqual({...kept},{status:'archived',read:1});assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
 assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='manual'").get().category,'promotions');assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='new-arrival'").get().category,'primary');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mail_sorting_feedback').get().n,0);
 const processed=f.row(job.id).processed;await app.processContentAudit(f.env,job.id);assert.equal(f.row(job.id).processed,processed);
});
test('AI only reviews unresolved primary mail; unavailable/uncertain cases become review items without stopping',async t=>{
 const f=await fixture(t);f.add('advert',{category:'promotions'});f.add('social',{category:'social'});f.add('clear');f.add('uncertain');f.add('failed');
 let calls=0;f.env.AI.run=async()=>{calls++;if(calls===3)throw Error('AI temporarily unavailable');return {answers:answers('promotions',calls===2?.6:.95)};};
 const job=await f.start();await f.drain(job.id);assert.equal(calls,3);assert.equal(f.row(job.id).processed,5);assert.equal(f.row(job.id).changed,1);assert.equal(f.row(job.id).review_count,2);
 assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='uncertain'").get().category,'primary');assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='failed'").get().category,'primary');
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mail_sorting_feedback').get().n,0);
});
test('rules finish before quota waits, then cron resumes cursor without a browser',async t=>{
 const f=await fixture(t);f.add('todo');f.add('receipt',{subject:'Ihre Rechnung',category:'promotions'});
 f.DB.db.exec("INSERT INTO mailbox_sorting_settings(mailbox_id,daily_limit) VALUES('box',2)");const day=new Date().toISOString().slice(0,10);f.DB.db.prepare('INSERT INTO mail_sorting_usage VALUES(?,?,1,0)').run('box',day);
 const job=await f.start();await app.processContentAudit(f.env,job.id);assert.equal(f.row(job.id).processed,2);assert.equal(f.row(job.id).status,'waiting');assert.equal(f.row(job.id).error,'daily_limit');assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='receipt'").get().category,'invoices');assert.equal(f.calls.length,0);
 f.DB.db.exec('DELETE FROM mail_sorting_usage');f.DB.db.prepare('UPDATE mail_content_audit_jobs SET retry_at=0 WHERE id=?').run(job.id);await app.recoverContentAudits(f.env);assert.equal(f.queued.at(-1).kind,'mail.content-audit');await f.drain(job.id);assert.equal(f.calls.length,1);
});
test('confirming a suggestion teaches content examples, dismissing and automatic decisions do not',async t=>{
 const f=await fixture(t);f.add('review',{subject:'Ihre Rechnung',text:'Invoice number 42. Total paid €25.',category:'promotions',decision:'{"source":"manual"}'});
 const job=await f.start();await f.drain(job.id);const state=await (await app.GET(f.request())).json();assert.equal(state.issues.length,1);
 const response=await app.POST(f.request({mailboxId:'box',action:'review',issueId:state.issues[0].id,category:'invoices'}));assert.equal(response.status,200,await response.clone().text());
 assert.equal(f.DB.db.prepare('SELECT status FROM messages').get().status,'archived');assert.equal(f.DB.db.prepare('SELECT read FROM messages').get().read,0);
 const examples=await app.getSortingExamples(f.env,'box');assert.equal(examples.length,1);assert.equal(examples[0].category,'invoices');assert.match(examples[0].visibleText,/Invoice number 42/);
 assert.equal((await app.POST(f.request({mailboxId:'box',action:'review',issueId:state.issues[0].id,category:'social'}))).status,404);
});
test('review, status and start enforce mailbox permissions; manual changes invalidate stale suggestions',async t=>{
 const f=await fixture(t);f.add('review',{subject:'Ihre Rechnung',category:'promotions',decision:'{"source":"manual"}'});const job=await f.start();await f.drain(job.id);
 for(const actor of ['other','reader']){assert.equal((await app.GET(f.request(null,actor))).status,404);assert.equal((await app.POST(f.request({mailboxId:'box',action:'start'},actor))).status,404);}
 const issue=f.DB.db.prepare('SELECT id FROM mail_content_audit_issues').get().id;f.DB.db.exec("UPDATE messages SET sorting_decision='new manual choice'");
 assert.equal((await app.POST(f.request({mailboxId:'box',action:'review',issueId:issue,category:'invoices'}))).status,409);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mail_sorting_feedback').get().n,0);
});
test('leases, paused jobs and disabled owners prevent parallel or unauthorized changes',async t=>{
 const f=await fixture(t);for(let i=0;i<201;i++)f.add('mail-'+i,{subject:'Ihre Rechnung'});const job=await f.start();
 await Promise.all([app.processContentAudit(f.env,job.id),app.processContentAudit(f.env,job.id)]);assert.equal(f.row(job.id).processed,200);
 assert.equal((await app.POST(f.request({mailboxId:'box',action:'pause'}))).status,200);await app.processContentAudit(f.env,job.id);assert.equal(f.row(job.id).processed,200);
 assert.equal((await app.POST(f.request({mailboxId:'box',action:'resume'}))).status,200);f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");await app.processContentAudit(f.env,job.id);assert.equal(f.row(job.id).status,'failed');assert.equal(f.row(job.id).processed,200);
});
test('sidebar simplification retains IDs/memberships/rules and synchronizes display preferences idempotently',async t=>{
 const f=await fixture(t);f.add('old');f.DB.db.exec(`INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('shopping','owner','box','Shopping',1),('purchases','owner','box','Einkäufe',1),('old-travel','owner','box','Kategorie ""Reisen""',1),('travel','owner','box','Reisen',1),('news','owner','box','Neuigkeiten',1),('paperless','owner','box','Paperless',1),('processed','owner','box','processed',1);
 INSERT INTO message_labels VALUES('old','shopping'),('old','old-travel');
 INSERT INTO routing_rules(id,user_id,domain_id,scope,pattern,match_value,label_ids,mailbox_id,created_at) VALUES('rule','owner','domain','mailbox','x','x','["shopping"]','box',1);`);
 const response=await app.POST(f.request({mailboxId:'box',action:'structure'}));assert.equal(response.status,200);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,4);
 assert.equal(f.DB.db.prepare("SELECT label_ids FROM routing_rules WHERE id='rule'").get().label_ids,'["purchases"]');assert.equal(f.DB.db.prepare("SELECT parent_id FROM folders WHERE id='processed'").get().parent_id,'paperless');
 const pref=f.DB.db.prepare("SELECT hidden_label_ids,label_order FROM users WHERE id='owner'").get();assert(JSON.parse(pref.hidden_label_ids).includes('news'));assert.equal(JSON.parse(pref.label_order).box.root[2],'travel');
 await app.POST(f.request({mailboxId:'box',action:'structure'}));assert.equal(f.DB.db.prepare('SELECT count(*) n FROM folders').get().n,9);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,4);
 assert.equal(app.normalizeImportedLabel('Shopping'),'Einkäufe');assert.equal(app.normalizeImportedLabel('Kategorie ""Reisen""'),'Reisen');
});
test('backup covers review records and feedback excerpts; restored active snapshots require a fresh audit; old backups remain valid',async t=>{
 const f=await fixture(t);f.add('review',{subject:'Ihre Rechnung',category:'promotions',decision:'{"source":"manual"}'});const job=await f.start();await f.drain(job.id);const backup=await app.exportDatabaseRecords(f.DB),doc=JSON.parse(new TextDecoder().decode(backup));
 assert.equal(doc.tables.mail_content_audit_jobs.length,1);assert.equal(doc.tables.mail_content_audit_issues.length,1);
 doc.tables.mail_content_audit_jobs[0].status='running';await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);assert.equal(f.row(job.id).status,'paused');assert.equal(f.row(job.id).error,'restore_requires_restart');
 await app.processContentAudit(f.env,job.id);assert.equal(f.row(job.id).status,'paused');const restarted=await f.start();assert.notEqual(restarted.id,job.id);
 for(const table of ['mail_content_audit_jobs','mail_content_audit_issues']){delete doc.tables[table];doc.includedTables=doc.includedTables.filter(name=>name!==table);}await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(doc)).buffer);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mail_content_audit_jobs').get().n,0);
 f.DB.db.exec('DROP TABLE mail_content_audit_issues;DROP TABLE mail_content_audit_jobs;');await app.exportDatabaseRecords(f.DB);
});
test('transaction rules protect real debit/delivery notices without capturing installment adverts or quoted messages',()=>{
 assert.equal(app.resolveTransactionMail({sender:'x',subject:'Ihre nächste Ratenzahlung-Rate wird in Kürze abgebucht'}).category,'invoices');
 assert.equal(app.resolveTransactionMail({sender:'x',subject:'Jetzt kaufen: flexible Ratenzahlung'}),null);
 assert.equal(app.resolveTransactionMail({sender:'x',subject:'Geliefert: Dein Paket',text:'Bestellnr. 306-123-456'}).category,'orders');
 assert.equal(app.resolveTransactionMail({sender:'x',subject:'Geliefert: Unser Newsletter'}),null);
});
test('archive security and direct LinkedIn messages are checked even in advertising/social without AI costs',async t=>{
 const f=await fixture(t);f.add('amex',{subject:'AmEx Kennwort/Benutzername wurde geändert',category:'promotions'});f.add('inmail',{subject:'Netskope Sales Careers in Germany',category:'social',sender:'inmail-hit-reply@linkedin.com'});
 const job=await f.start();await f.drain(job.id);assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='amex'").get().category,'primary');assert.equal(f.DB.db.prepare("SELECT reason FROM mail_content_audit_issues WHERE message_id='inmail'").get().reason,'direct_message_review');assert.equal(f.calls.length,0);
 const quote={id:'quote',row_id:1,from_addr:'person@test.invalid',to_addr:'owner@test.invalid',subject:'Re: Invoice 123',text_body:'Thanks for the update. Invoice number 123. Amount paid €25.',html_body:null,snippet:null,category:'primary',sorting_decision:null,spam_score:0,in_reply_to:null};assert.equal(app.deterministicReview(quote).category,'primary');
 assert.equal(app.reviewText({text_body:null,html_body:'<style>body { color:red; ' ,snippet:'Invoice 123'}),'Invoice 123');
});
test('the complete second pass cannot reclassify a conversation from quoted financial content',async t=>{
 const f=await fixture(t);f.add('quote',{subject:'Re: Invoice 123',text:'Thanks for the update. Invoice number 123. Total paid €25.'});f.add('financial-reply',{subject:'Re: Invoice 456',category:'invoices',text:'Thanks for the update. Invoice number 456. Total paid €25.'});const job=await f.start();await f.drain(job.id);assert.equal(f.calls.length,0);assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='quote'").get().category,'primary');assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='financial-reply'").get().category,'invoices');assert.equal(f.row(job.id).review_count,1);
});
test('a lost response after committed checkpoint retries without duplicate changes or review suggestions',async t=>{
 const f=await fixture(t);f.add('receipt',{subject:'Ihre Rechnung',category:'promotions'});const job=await f.start();const batch=f.DB.batch.bind(f.DB);let failed=false;f.DB.batch=async statements=>{const result=await batch(statements);if(!failed){failed=true;throw Error('Lost checkpoint response');}return result;};
 await app.processContentAudit(f.env,job.id);assert.equal(f.row(job.id).processed,1);assert.equal(f.row(job.id).changed,1);assert.equal(f.row(job.id).status,'waiting');f.DB.db.prepare('UPDATE mail_content_audit_jobs SET retry_at=0 WHERE id=?').run(job.id);await f.drain(job.id);assert.equal(f.row(job.id).processed,1);assert.equal(f.row(job.id).changed,1);
});
