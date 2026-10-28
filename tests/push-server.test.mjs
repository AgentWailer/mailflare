import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createECDH,createDecipheriv,hkdfSync,randomBytes } from 'node:crypto';

const directory=mkdtempSync(join(process.cwd(),'node_modules','mailflare-push-server-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
writeFileSync(join(directory,'headers.mjs'),'export async function cookies(){return {get:name=>name==="ep_session"&&globalThis.__mailflarePushTestCookie?{value:globalThis.__mailflarePushTestCookie}:undefined};}');
await build({stdin:{contents:`
 export { SqliteDatabase } from './server/runtime/sqlite-database.ts';
 export { applyMigrations } from './server/runtime/migrate.ts';
 export { createSession } from './src/lib/auth/session.ts';
 export { getMailboxNotificationUserIds,notifyUsersOfNewMessage } from './src/lib/realtime/utils.ts';
 export { sendPushNotifications } from './src/lib/push/server.ts';
 export { GET as badge } from './src/app/api/push/badge/route.ts';
 export { GET as config } from './src/app/api/push/config/route.ts';
 export { POST as pushTest } from './src/app/api/push/test/route.ts';
 export { POST as subscribe } from './src/app/api/push/subscriptions/route.ts';
`,resolveDir:process.cwd()},outfile:join(directory,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(directory,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(directory,'app.mjs')).href);

async function fixture(t){
 const database=new app.SqliteDatabase(':memory:');t.after(()=>{database.db.close();delete globalThis.__mailflareNodeEnv;});
 await app.applyMigrations(database,join(process.cwd(),'drizzle/migrations'));
 database.db.exec(`
 INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Admin','admin',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','other','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('mailbox','owner','domain','owner','personal',1),('other-mailbox','other','domain','other','personal',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('custom','owner','mailbox','Projects',1);
 INSERT INTO messages(id,user_id,mailbox_id,folder_id,direction,from_addr,to_addr,status,read,created_at) VALUES
 ('message','owner','mailbox',NULL,'inbound','sender@example.test','owner@example.test','received',0,1),
 ('custom-message','owner','mailbox','custom','inbound','sender@example.test','owner@example.test','received',0,1),
 ('spam','owner','mailbox',NULL,'inbound','sender@example.test','owner@example.test','spam',0,1),
 ('trash','owner','mailbox',NULL,'inbound','sender@example.test','owner@example.test','trash',0,1),
 ('archive','owner','mailbox',NULL,'inbound','sender@example.test','owner@example.test','archived',0,1),
 ('read','owner','mailbox',NULL,'inbound','sender@example.test','owner@example.test','received',1,1),
 ('snoozed','owner','mailbox',NULL,'inbound','sender@example.test','owner@example.test','received',0,1),
 ('other-message','other','other-mailbox',NULL,'inbound','sender@example.test','other@example.test','received',0,1);
 `);
 database.db.prepare("UPDATE messages SET snoozed_until=? WHERE id='snoozed'").run(Math.floor(Date.now()/1000)+3600);
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const publicKey=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url');
 const privateKey=(await crypto.subtle.exportKey('jwk',pair.privateKey)).d;
 const env={DB:database,MAILFLARE_RUNTIME:'node',VAPID_PUBLIC_KEY:publicKey,VAPID_PRIVATE_KEY:privateKey,VAPID_SUBJECT:'https://mailflare.test'};
 globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const user of ['owner','other'])tokens[user]=await app.createSession(env,user);
 const receiver=createECDH('prime256v1');receiver.generateKeys();const auth=randomBytes(16);
 const keys={p256dh:receiver.getPublicKey().toString('base64url'),auth:auth.toString('base64url')};
 for(const user of ['owner','other'])database.db.prepare('INSERT INTO push_subscriptions(id,user_id,session_id,endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,(SELECT id FROM sessions WHERE user_id=?),?,?,?,?,?)').run('push-'+user,user,user,'https://web.push.apple.com/'+user,keys.p256dh,keys.auth,1,1);
 const deliveries=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{deliveries.push({url,init});return new Response(null,{status:201});});
 const request=(user,path='/api/push/badge',body)=>new Request('https://mailflare.test'+path,{method:body?'POST':'GET',headers:user?{Authorization:'Bearer '+tokens[user],'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
 function decrypt(body){
  const buffer=Buffer.from(body);const salt=buffer.subarray(0,16);const publicKey=buffer.subarray(21,21+buffer[20]);const ciphertext=buffer.subarray(21+buffer[20]);
  const secret=receiver.computeSecret(publicKey);
  const ikm=hkdfSync('sha256',secret,auth,Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),publicKey]),32);
  const key=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16);
  const nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
  const decipher=createDecipheriv('aes-128-gcm',Buffer.from(key),Buffer.from(nonce));decipher.setAuthTag(ciphertext.subarray(-16));
  const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);assert.equal(plain.at(-1),2);
  return JSON.parse(plain.subarray(0,-1).toString());
 }
 const payload={type:'new_message',mailboxId:'mailbox',messageId:'message',from:'sam@example.test',fromName:'Sam',subject:'Invoice'};
 return {database,env,tokens,keys,deliveries,request,decrypt,payload};
}

test('badge counts only unread primary inbox mail and clears when it is read',async t=>{
 const f=await fixture(t);assert.equal((await app.badge(f.request(null))).status,401);
 const response=await app.badge(f.request('owner'));assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.deepEqual(await response.json(),{unreadCount:1});
 assert.deepEqual(await (await app.badge(f.request('other'))).json(),{unreadCount:1});
 f.database.db.exec("UPDATE messages SET read=1 WHERE mailbox_id='mailbox'");assert.deepEqual(await (await app.badge(f.request('owner'))).json(),{unreadCount:0});
});

test('domain administrators never receive notifications for someone else’s personal mailbox',async t=>{
 const f=await fixture(t);assert.deepEqual(await app.getMailboxNotificationUserIds(f.env,'mailbox','owner'),['owner']);
 await app.sendPushNotifications(f.env,['owner','other'],f.payload);assert.equal(f.deliveries.length,1);assert.equal(f.deliveries[0].url,'https://web.push.apple.com/owner');
 const payload=f.decrypt(f.deliveries[0].init.body);assert.equal(payload.unreadCount,1);assert.equal(payload.title,'Sam');assert.equal(payload.body,'Invoice');assert.equal(payload.url,'/inbox/message');
 assert.match(f.deliveries[0].init.headers.Authorization,/^vapid t=/);
});

test('push reaches closed apps even when there is no realtime websocket binding',async t=>{
 const f=await fixture(t);await app.notifyUsersOfNewMessage(f.env,['owner'],f.payload);assert.equal(f.deliveries.length,1);
});

test('shared mailbox push and badge counts stop immediately after an access grant is revoked',async t=>{
 const f=await fixture(t);f.database.db.exec("UPDATE mailboxes SET type='shared' WHERE id='mailbox';INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('grant','mailbox','other','read_only',1)");
 await app.sendPushNotifications(f.env,['owner','other'],f.payload);assert.equal(f.deliveries.length,2);assert.equal(f.decrypt(f.deliveries.find(x=>x.url.endsWith('/other')).init.body).unreadCount,2);
 f.database.db.exec("DELETE FROM mailbox_access WHERE id='grant'");f.deliveries.length=0;
 await app.sendPushNotifications(f.env,['owner','other'],f.payload);assert.equal(f.deliveries.length,1);assert.deepEqual(await (await app.badge(f.request('other'))).json(),{unreadCount:1});
});

test('disabled users/mailboxes and expired sessions receive no email push',async t=>{
 const f=await fixture(t);
 f.database.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");await app.sendPushNotifications(f.env,['owner'],f.payload);assert.equal(f.deliveries.length,0);
 f.database.db.exec("UPDATE users SET disabled=0 WHERE id='owner';UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");await app.sendPushNotifications(f.env,['owner'],f.payload);assert.equal(f.deliveries.length,0);
 f.database.db.exec("UPDATE mailboxes SET disabled=0 WHERE id='mailbox';UPDATE sessions SET expires_at=1 WHERE user_id='owner'");await app.sendPushNotifications(f.env,['owner'],f.payload);assert.equal(f.deliveries.length,0);
});

test('a test push is limited to the authenticated user’s selected device',async t=>{
 const f=await fixture(t);const own='https://web.push.apple.com/owner';
 assert.equal((await app.pushTest(f.request(null,'/api/push/test',{endpoint:own}))).status,401);
 assert.equal((await app.pushTest(f.request('other','/api/push/test',{endpoint:own}))).status,502);assert.equal(f.deliveries.length,0);
 assert.equal((await app.pushTest(f.request('owner','/api/push/test',{endpoint:own}))).status,200);assert.equal(f.deliveries.length,1);assert.equal(f.decrypt(f.deliveries[0].init.body).tag,'mailflare-push-test');
});

test('cookie-authenticated subscription changes reject cross-origin requests',async t=>{
 const f=await fixture(t);globalThis.__mailflarePushTestCookie=f.tokens.owner;t.after(()=>delete globalThis.__mailflarePushTestCookie);const request=new Request('https://mailflare.test/api/push/subscriptions',{method:'POST',headers:{Cookie:'ep_session='+f.tokens.owner,Origin:'https://attacker.test'},body:JSON.stringify({endpoint:'https://web.push.apple.com/new',keys:f.keys})});
 assert.equal((await app.subscribe(request)).status,403);assert.equal(f.database.db.prepare('SELECT count(*) n FROM push_subscriptions').get().n,2);
});

test('missing VAPID server keys are reported explicitly and expired endpoints are removed',async t=>{
 const f=await fixture(t);const privateKey=f.env.VAPID_PRIVATE_KEY;delete f.env.VAPID_PRIVATE_KEY;
 assert.deepEqual(await (await app.config(f.request('owner','/api/push/config'))).json(),{enabled:false,publicKey:null});
 assert.equal((await app.pushTest(f.request('owner','/api/push/test',{endpoint:'https://web.push.apple.com/owner'}))).status,503);
 f.env.VAPID_PRIVATE_KEY=privateKey;t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:410}));
 await app.sendPushNotifications(f.env,['owner'],f.payload);assert.equal(f.database.db.prepare("SELECT count(*) n FROM push_subscriptions WHERE user_id='owner'").get().n,0);
});

 test('promotions, social, spam and archived messages never trigger web push',async t=>{
  const f=await fixture(t);
  for(const category of ['promotions','social']){f.database.db.prepare("UPDATE messages SET category=? WHERE id='message'").run(category);await app.sendPushNotifications(f.env,['owner'],f.payload);}
  f.database.db.exec("UPDATE messages SET category='primary',status='spam' WHERE id='message'");await app.sendPushNotifications(f.env,['owner'],f.payload);
  f.database.db.exec("UPDATE messages SET status='archived' WHERE id='message'");await app.sendPushNotifications(f.env,['owner'],f.payload);
  assert.equal(f.deliveries.length,0);
 });


test('encrypted push contains sender, subject and readable message content without tracking links',async t=>{
 const f=await fixture(t);
 f.database.db.prepare("UPDATE messages SET snippet=?,text_body=? WHERE id='message'").run('View this email in your browser https://tracking.example.test/long-token','Your payment has arrived. Thank you!');
 await app.sendPushNotifications(f.env,['owner','other'],f.payload);
 assert.equal(f.deliveries.length,1);
 const payload=f.decrypt(f.deliveries[0].init.body);
 assert.equal(payload.title,'Sam');assert.equal(payload.body,'Invoice\nYour payment has arrived. Thank you!');
 assert.equal(payload.tag,'message');assert.equal(payload.url,'/inbox/message');assert.equal(payload.unreadCount,1);
 assert(!Buffer.from(f.deliveries[0].init.body).includes(Buffer.from('Your payment')),'content remains encrypted in transit to push provider');
});

test('HTML-only mail gets a plain preview; empty sender name falls back to address',async t=>{
 const f=await fixture(t);
 f.database.db.prepare("UPDATE messages SET html_body=? WHERE id='message'").run('<html><head><style>hidden CSS</style></head><body><p>Your parcel arrives tomorrow.</p><a href="https://tracking.example.test">Track parcel</a></body></html>');
 await app.sendPushNotifications(f.env,['owner'],{...f.payload,fromName:'  ',subject:null});
 const payload=f.decrypt(f.deliveries[0].init.body);
 assert.equal(payload.title,'sam@example.test');assert.equal(payload.body,'Your parcel arrives tomorrow. Track parcel');
});

test('long Unicode push previews stay bounded without corrupting emoji or injecting header lines',async t=>{
 const f=await fixture(t);
 f.database.db.prepare("UPDATE messages SET snippet=? WHERE id='message'").run('📦'.repeat(1000));
 await app.sendPushNotifications(f.env,['owner'],{...f.payload,fromName:'Sam\r\nExample',subject:'😀'.repeat(1000)});
 const payload=f.decrypt(f.deliveries[0].init.body);
 assert.equal(payload.title,'Sam Example');assert.equal(payload.body.split('\n').length,2);
 assert(Array.from(payload.body.split('\n')[0]).length<=100);assert(Array.from(payload.body.split('\n')[1]).length<=180);
 assert(!payload.body.includes('�'));assert(Buffer.byteLength(JSON.stringify(payload))<3000);
 assert(Buffer.from(f.deliveries[0].init.body).length<4096);
});
