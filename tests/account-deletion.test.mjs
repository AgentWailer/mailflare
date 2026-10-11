import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-account-delete-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
export {applyMigrations} from './server/runtime/migrate.ts';export {createSession,getUserFromSession} from './src/lib/auth/session.ts';
export {GET as getAccount,DELETE as remove,PATCH as update} from './src/app/api/accounts/[id]/route.ts';
export {GET as listAccounts} from './src/app/api/accounts/route.ts';
export {deleteManagedAccount} from './src/app/api/accounts/[id]/delete.ts';
export {resolveAccounts} from './src/lib/auth/accounts.ts';
export {resolveInboundAddress} from './src/lib/email/routing.ts';
export {getDb} from './src/db/index.ts';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,is_primary_admin,can_manage_users,created_at) VALUES
 ('primary','primary@example.test','hash','Primary','admin',1,1,1),('manager','manager@example.test','hash','Manager','admin',0,1,1),
 ('admin','admin@example.test','hash','Admin','admin',0,0,1),('target','target@example.test','hash','Target','user',0,0,1),('other','other@example.test','hash','Other','user',0,0,1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','target','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','target','domain','target','personal',1),('otherbox','other','domain','other','personal',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('label','target','box','Work',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at,folder_id,raw_r2_key) VALUES
 ('message','target','box','inbound','sender@example.test','target@example.test','received',1,'label','raw-email'),
 ('foreign','other','otherbox','inbound','sender@example.test','other@example.test','received',1,NULL,'foreign-email'),
 ('scheduled','target','box','outbound','target@example.test','recipient@example.test','queued',1,NULL,NULL);
 INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES ('message','label');
 INSERT INTO message_attachments(id,message_id,r2_key,filename,content_type,size,created_at) VALUES ('attachment','message','attachment-object','test.txt','text/plain',5,1);
 INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES ('alias','box','domain','sales',1);
 INSERT INTO routing_rules(id,user_id,domain_id,scope,pattern,match_field,match_value,action,mailbox_id,created_at) VALUES ('route','target','domain','domain','*','recipient','*','store','box',1);
 INSERT INTO drive_items(id,owner_id,kind,name,r2_key,link_token,created_at,updated_at) VALUES ('file','target','file','Document','drive-object','public-link',1,1);
 INSERT INTO drive_shares(id,item_id,user_id,role,created_at) VALUES ('share','file','target','edit',1),('othershare','file','other','view',1);
 INSERT INTO contacts(id,user_id,email,avatar_key,created_at) VALUES ('contact','target','contact@example.test','private-avatar',1);
 INSERT INTO calendar_events(id,user_id,title,starts_at,ends_at,created_at,updated_at) VALUES ('event','target','Private',1,2,1,1);
 INSERT INTO api_keys(id,user_id,name,prefix,key_hash,scopes,created_at) VALUES ('key','target','Key','prefix','keyhash','[]',1);
 INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('access','otherbox','target','read_only',1),('otheraccess','box','other','read_only',1);
 INSERT INTO mailbox_agent_settings(mailbox_id,auto_draft_enabled,reviewer_user_id,updated_at) VALUES ('box',1,'target',1);
 INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES ('job','target','scheduled','queued','{}',4102444800,1,1);
 INSERT INTO mail_sorting_feedback(id,mailbox_id,message_id,sender,subject,category,corrected_at) VALUES ('learning','box','message','sender@example.test','Offer','promotions','2026-10-11');`);
 const deletedKeys=[];
 const env={DB,MAILFLARE_RUNTIME:'node',BUCKET:{delete:async(keys)=>{deletedKeys.push(...keys);}}};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['primary','manager','admin','target','other'])tokens[id]=await app.createSession(env,id);
 DB.db.exec(`INSERT INTO push_subscriptions(id,user_id,session_id,endpoint,p256dh,auth,created_at,updated_at)
 SELECT 'push','target',id,'https://push.example.test','p256','auth',1,1 FROM sessions WHERE user_id='target';`);
 const request=(actor='primary',body={confirmEmail:'target@example.test'},method='DELETE',extra={})=>new Request('https://mailflare.test/api/accounts/target',{method,headers:{Authorization:'Bearer '+tokens[actor],'Content-Type':'application/json',...extra},...(method==='GET'?{}:{body:JSON.stringify(body)})});
 const params=id=>({params:Promise.resolve({id})});
 const scalar=sql=>DB.db.prepare(sql).get();
 return {DB,env,tokens,request,params,scalar,deletedKeys};
}
test('deletion revokes identity and preserves mail, labels, attachments, routes and Drive under primary admin',async t=>{
 const f=await fixture(t);f.DB.db.exec("UPDATE users SET avatar_key='profile-avatar' WHERE id='target'");
 const response=await app.remove(f.request(),f.params('target'));assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),{ok:true,cleanupPending:false});
 assert.equal(f.scalar("SELECT count(*) n FROM users WHERE id='target'").n,0);
 for(const [table,column,id] of [['mailboxes','user_id','box'],['domains','user_id','domain'],['messages','user_id','message'],['folders','user_id','label'],['routing_rules','user_id','route'],['drive_items','owner_id','file']])assert.equal(f.scalar(`SELECT ${column} owner FROM ${table} WHERE id='${id}'`).owner,'primary');
 assert.equal(f.scalar("SELECT avatar_key FROM mailboxes WHERE id='box'").avatar_key,'profile-avatar');
 assert.equal(f.scalar("SELECT user_id FROM messages WHERE id='foreign'").user_id,'other');
 assert.equal(f.scalar("SELECT status FROM messages WHERE id='scheduled'").status,'draft');
 for(const table of ['message_labels','message_attachments','mailbox_aliases','mail_sorting_feedback'])assert.equal(f.scalar(`SELECT count(*) n FROM ${table}`).n,1);
 assert.equal(f.scalar("SELECT r2_key,link_token FROM drive_items WHERE id='file'").r2_key,'drive-object');assert.equal(f.scalar("SELECT link_token FROM drive_items WHERE id='file'").link_token,null);
 assert.equal(f.scalar("SELECT count(*) n FROM drive_shares WHERE user_id='other'").n,1);assert.equal(f.scalar("SELECT count(*) n FROM mailbox_access WHERE user_id='other'").n,1);
 for(const table of ['sessions','push_subscriptions','api_keys','contacts','calendar_events','mailbox_access','outbound_jobs'])assert.equal(f.scalar(`SELECT count(*) n FROM ${table} WHERE user_id='target'`).n,0);
 assert.equal(f.scalar("SELECT auto_draft_enabled FROM mailbox_agent_settings WHERE mailbox_id='box'").auto_draft_enabled,0);
 assert.equal(await app.getUserFromSession(f.env,f.tokens.target),null);assert.deepEqual(await app.resolveAccounts(f.env,[f.tokens.target]),[]);
 assert.equal((await app.resolveInboundAddress(app.getDb(f.env),'sales@example.test')).mailbox.mailboxId,'box');
 assert.equal((await app.resolveInboundAddress(app.getDb(f.env),'new-address@example.test')).mailbox.mailboxId,'box');
 assert.deepEqual(f.deletedKeys,['private-avatar','private-avatar:preview']);assert(!f.deletedKeys.includes('attachment-object'));
 const audit=f.scalar("SELECT metadata FROM audit_logs WHERE action='account.deleted'");assert.equal(JSON.parse(audit.metadata).assetsTransferredTo,'primary');
 assert.deepEqual(f.DB.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('only authorized admins may delete, primary and own account stay protected',async t=>{
 const f=await fixture(t);
 for(const actor of ['other','target','admin'])assert.equal((await app.remove(f.request(actor),f.params('target'))).status,403);
 assert.equal((await app.remove(f.request(),f.params('primary'))).status,409);
 assert.equal((await app.remove(f.request('manager',{confirmEmail:'manager@example.test'}),f.params('manager'))).status,409);
 assert.equal((await app.remove(f.request('manager',{confirmEmail:'admin@example.test'}),f.params('admin'))).status,403);
 assert.equal(f.scalar("SELECT count(*) n FROM users").n,5);
 assert.equal((await app.remove(f.request('manager'),f.params('target'))).status,200);
});
test('explicit confirmation and same-origin cookie mutation are required; failed validation preserves data',async t=>{
 const f=await fixture(t);
 for(const body of [{},{confirmEmail:'wrong@example.test'},{confirmEmail:42},null])assert.equal((await app.remove(f.request('primary',body),f.params('target'))).status,400);
 const crossSite=new Request('https://mailflare.test/api/accounts/target',{method:'DELETE',headers:{Cookie:'ep_session='+f.tokens.primary,Origin:'https://evil.test','Sec-Fetch-Site':'cross-site','Content-Type':'application/json'},body:JSON.stringify({confirmEmail:'target@example.test'})});
 assert.equal((await app.remove(crossSite,f.params('target'))).status,403);
 assert.equal(f.scalar("SELECT user_id FROM mailboxes WHERE id='box'").user_id,'target');
 assert.equal((await app.remove(f.request(),f.params('missing'))).status,404);
});
test('atomic batch rolls back transfers on failure and rechecks primary/permission changes',async t=>{
 const f=await fixture(t);
 f.DB.db.exec("CREATE TRIGGER refuse_account_delete BEFORE DELETE ON users WHEN old.id='target' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 await assert.rejects(app.deleteManagedAccount(f.env,{id:'target',email:'target@example.test',actorId:'primary',successorId:'primary'}));
 assert.equal(f.scalar("SELECT user_id FROM domains WHERE id='domain'").user_id,'target');assert.equal(f.scalar("SELECT owner_id FROM drive_items WHERE id='file'").owner_id,'target');assert.equal(f.scalar('SELECT count(*) n FROM audit_logs').n,0);assert.deepEqual(f.deletedKeys,[]);
 f.DB.db.exec('DROP TRIGGER refuse_account_delete;');
 f.DB.db.exec("UPDATE users SET is_primary_admin=1,role='admin' WHERE id='target'");
 await assert.rejects(app.deleteManagedAccount(f.env,{id:'target',email:'target@example.test',actorId:'primary',successorId:'primary'}));
 f.DB.db.exec("UPDATE users SET is_primary_admin=0,role='user' WHERE id='target'; UPDATE users SET can_manage_users=0 WHERE id='manager';");
 await assert.rejects(app.deleteManagedAccount(f.env,{id:'target',email:'target@example.test',actorId:'manager',successorId:'primary'}));
 assert.equal(f.scalar("SELECT user_id FROM mailboxes WHERE id='box'").user_id,'target');
});
test('profile image cleanup failure is reported after successful deletion, with retry information in audit',async t=>{
 const f=await fixture(t);f.env.BUCKET.delete=async()=>{throw new Error('temporary storage failure');};
 const response=await app.remove(f.request(),f.params('target'));assert.equal(response.status,200);assert.equal((await response.json()).cleanupPending,true);
 assert.equal(f.scalar("SELECT count(*) n FROM users WHERE id='target'").n,0);assert.deepEqual(JSON.parse(f.scalar('SELECT metadata FROM audit_logs').metadata).pendingAvatarCleanup,['private-avatar','private-avatar:preview']);
});
test('deletion availability and enabled state are exposed consistently in account APIs',async t=>{
 const f=await fixture(t);f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='target'");
 let response=await app.getAccount(f.request('primary',null,'GET'),f.params('target'));let data=await response.json();assert.equal(data.account.deletable,true);assert.equal(data.account.disabled,true);
 response=await app.getAccount(f.request('primary',null,'GET'),f.params('primary'));assert.equal((await response.json()).account.deletable,false);
 response=await app.getAccount(f.request('manager',null,'GET'),f.params('admin'));assert.equal((await response.json()).account.deletable,false);
 response=await app.listAccounts(f.request('primary',null,'GET'));data=await response.json();assert.equal(data.accounts.find(x=>x.id==='target').disabled,true);assert.equal(data.accounts.find(x=>x.id==='primary').disabled,false);
});
test('disabling an account revokes its sessions even if it is re-enabled later',async t=>{
 const f=await fixture(t);
 const body={name:'Target',role:'user',disabled:true,canManageMailboxes:false,canManageDomains:false,canManageUsers:false};
 const response=await app.update(f.request('primary',body,'PATCH'),f.params('target'));assert.equal(response.status,200,await response.clone().text());
 assert.equal(f.scalar("SELECT disabled FROM users WHERE id='target'").disabled,1);assert.equal(await app.getUserFromSession(f.env,f.tokens.target),null);
 body.disabled=false;assert.equal((await app.update(f.request('primary',body,'PATCH'),f.params('target'))).status,200);assert.equal(await app.getUserFromSession(f.env,f.tokens.target),null);
});
