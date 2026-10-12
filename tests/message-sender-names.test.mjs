import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','sender-names-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined}}');
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
 export {createSession} from './src/lib/auth/session';
 export {GET as list} from './src/app/api/messages/route';
 export {getMessageThreadForUser} from './src/lib/email/thread-view';
 export {getMessageWithBodyForUser} from './src/lib/email/inbound';
 export {getMessageContactNames,upsertContactFromAddress,getContactDisplayNameMap} from './src/lib/contacts/service';
 export {getMessageParty,formatRecipientSummary} from './src/components/messages/utils';
 export {getConversationSender} from './src/components/messages/conversation-thread-utils';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,'drizzle/migrations');
 t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1),('foreign','foreign@example.test','hash','Foreign','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1);
 INSERT INTO contacts(id,user_id,email,display_name,source,avatar_key,created_at) VALUES('linkedin','owner','invitations@linkedin.com','Latest unrelated person','inbound','avatars/linkedin',1),('recipient','owner','owner@example.test','Latest recipient','outbound',NULL,1),('foreign-contact','foreign','invitations@linkedin.com','Foreign custom name','manual',NULL,1);`);
 const insert=DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,category,thread_id,read,created_at) VALUES(?,'owner','box','inbound',?,? ,?,'received','social','thread',0,?)");
 insert.run('first','"Benjamin Ding" <invitations@linkedin.com>','"Owner One" <owner@example.test>','I want to connect',1);
 insert.run('second','"Kerstin Baumgart" <invitations@linkedin.com>','"Owner Two" <owner@example.test>','I just requested to connect',2);
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;
 const user={id:'owner',email:'owner@example.test',name:'Owner',role:'user'},token=await app.createSession(env,'owner');
 const list=async(group=false)=>{const response=await app.list(new Request('https://mailflare.test/api/messages?mailboxId=box'+(group?'&group=thread':''),{headers:{Authorization:'Bearer '+token}}));assert.equal(response.status,200);return response.json();};
 return {DB,env,user,list};
}

test('message list retains each original sender and recipient after successive shared-address contact updates',async t=>{
 const f=await fixture(t),before=f.DB.db.prepare('SELECT id,from_addr,to_addr,subject FROM messages ORDER BY id').all();
 for(const name of ['Ahmed Hendawy','Dr. Kerstin Baumgart','Another LinkedIn member']){
  await app.upsertContactFromAddress(f.env,{userId:'owner',address:`"${name}" <invitations@linkedin.com>`,source:'inbound'});
  const data=await f.list();assert.equal(data.total,2);
  assert.deepEqual(data.messages.map(row=>app.getMessageParty(row,'social')),['Kerstin Baumgart','Benjamin Ding']);
  assert.deepEqual(data.messages.map(row=>app.formatRecipientSummary(row.toAddr,row.toContactName)),['Owner Two','Owner One']);
  assert(data.messages.every(row=>row.fromContactHasAvatar));
  assert.deepEqual(f.DB.db.prepare('SELECT id,from_addr,to_addr,subject FROM messages ORDER BY id').all(),before);
 }
 const grouped=await f.list(true);assert.equal(grouped.messages.length,1);assert.equal(grouped.messages[0].threadCount,2);assert.equal(app.getMessageParty(grouped.messages[0],'social'),'Kerstin Baumgart');
});

test('reading pane and conversation retain individual names from the same address',async t=>{
 const f=await fixture(t),thread=await app.getMessageThreadForUser(f.env,f.user,'first');
 assert.deepEqual(thread.messages.map(row=>app.getConversationSender(row)),['Benjamin Ding','Kerstin Baumgart']);
 for(const id of ['first','second']){
  const detail=await app.getMessageWithBodyForUser(f.env,f.user,id);
  assert.equal(app.getMessageParty(detail.message,'social'),id==='first'?'Benjamin Ding':'Kerstin Baumgart');
  assert.equal(detail.message.fromContactName,null);assert.equal(detail.message.toContactName,null);
 }
 const foreign=await app.getMessageThreadForUser(f.env,{...f.user,id:'foreign',email:'foreign@example.test'},'first');assert.equal(foreign,null);
});

test('manually chosen contact names override headers and automatic updates cannot change them',async t=>{
 const f=await fixture(t);f.DB.db.exec("UPDATE contacts SET display_name='My LinkedIn contact',source='manual' WHERE id='linkedin';UPDATE contacts SET display_name='My recipient',source='manual' WHERE id='recipient'");
 await app.upsertContactFromAddress(f.env,{userId:'owner',address:'"Another sender" <invitations@linkedin.com>',source:'inbound'});
 const list=await f.list();assert(list.messages.every(row=>app.getMessageParty(row,'social')==='My LinkedIn contact'));assert(list.messages.every(row=>row.toContactName==='My recipient'));
 const thread=await app.getMessageThreadForUser(f.env,f.user,'first');assert(thread.messages.every(row=>app.getConversationSender(row)==='My LinkedIn contact'));
 const detail=await app.getMessageWithBodyForUser(f.env,f.user,'first');assert.equal(detail.message.fromContactName,'My LinkedIn contact');
});

test('bare addresses use their own address unless a user explicitly assigns a contact name',async t=>{
 const f=await fixture(t),names=await app.getMessageContactNames(f.env,'owner','invitations@linkedin.com','owner@example.test');
 assert.equal(app.getMessageParty({fromAddr:'invitations@linkedin.com',direction:'inbound',...names},'social'),'invitations');
 assert.equal((await app.getContactDisplayNameMap(f.env,'owner',[])).size,0);
 f.DB.db.exec("UPDATE contacts SET source='manual',display_name='LinkedIn' WHERE id='linkedin'");
 const manual=await app.getMessageContactNames(f.env,'owner','invitations@linkedin.com','owner@example.test');assert.equal(manual.fromContactName,'LinkedIn');
});

test('the same protection applies to arbitrary providers, outbound-derived contacts and recipient summaries',async t=>{
 const f=await fixture(t);t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:404}));
 for(const [email,source] of [['alerts@facebookmail.com','inbound'],['billing@uber.com','inbound'],['notifications@company.example','outbound'],['shared@example.test','inbound']]){
  f.DB.db.exec('DELETE FROM messages');
  await app.upsertContactFromAddress(f.env,{userId:'owner',address:`"Newest unrelated name" <${email}>`,source});
  const insert=f.DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,category,thread_id,read,created_at) VALUES(?,'owner','box',?,?,? ,?,'received','primary','thread',0,?)");
  insert.run('first','inbound',`"Original Name One" <${email}>`,'"Doe, Jane" <owner@example.test>','Original subject one',1);
  insert.run('second','inbound',`"Original Name Two" <${email}>`,'"Jörg Müller" <owner@example.test>','Original subject two',2);
  const list=await f.list();assert.deepEqual(list.messages.map(row=>app.getMessageParty(row,'inbox')),['Original Name Two','Original Name One'],email);
  const thread=await app.getMessageThreadForUser(f.env,f.user,'first');assert.deepEqual(thread.messages.map(row=>app.getConversationSender(row)),['Original Name One','Original Name Two'],email);
  assert.deepEqual(list.messages.map(row=>app.formatRecipientSummary(row.toAddr,row.toContactName)),['Jörg Müller','Doe, Jane']);
  assert.equal((await app.getMessageWithBodyForUser(f.env,f.user,'first')).message.subject,'Original subject one');
  f.DB.db.prepare("UPDATE messages SET direction='outbound',status='sent',to_addr=? WHERE id='first'").run(`"Original Recipient" <${email}>`);
  const sent=(await f.list()).messages.find(row=>row.id==='first');assert.equal(app.getMessageParty(sent,'sent'),'Original Recipient');
 }
});
