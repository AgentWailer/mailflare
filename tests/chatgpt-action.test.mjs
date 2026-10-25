import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','chatgpt-action-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined}}');
writeFileSync(join(dir,'provider.mjs'),`export async function getOutboundProviderConfig(){return {provider:'cloudflare'}};export async function sendThroughProvider(env,config,message){globalThis.__chatgptDeliveries.push(message);return {messageId:'<provider-id@example.test>'}};`);
await build({stdin:{contents:`export {createChatGptSendAction} from './src/lib/integrations/chatgpt-action';export {POST as send} from './src/app/api/v1/send/route';export {generateApiKey} from './src/lib/api-keys';export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts','@/lib/email/outbound-provider':join(dir,'provider.mjs')},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,'drizzle/migrations');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__chatgptDeliveries;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('foreign','other','domain','other','personal',1);`);
 const key=app.generateApiKey();DB.db.prepare("INSERT INTO api_keys(id,user_id,name,prefix,key_hash,scopes,mailbox_scope_enabled,created_at) VALUES('key','owner','ChatGPT',?,?,?,1,1)").run(key.prefix,key.hash,'["send"]');DB.db.exec("INSERT INTO mcp_key_mailboxes(key_id,mailbox_id) VALUES('key','box')");
 const objects=new Map(),env={DB,MAILFLARE_RUNTIME:'node',BUCKET:{put:async(k,v)=>objects.set(k,v),delete:async k=>objects.delete(k)}};globalThis.__mailflareNodeEnv=env;globalThis.__chatgptDeliveries=[];t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:404}));
 const body={mailboxId:'box',from:'owner@example.test',to:['recipient@example.test'],cc:['cc@example.test'],bcc:['bcc@example.test'],subject:'Approved test',text:'This test message was approved.'};
 const request=(fields={},token=key.fullKey)=>new Request('https://mailflare.test/api/v1/send',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...body,...fields})});
 return {DB,key,env,objects,body,request};
}
test('the generated action is limited to one send endpoint and mailbox, requires confirmation and embeds no credential',()=>{
 const schema=app.createChatGptSendAction('https://mailflare.test',{id:'box',address:'owner@example.test'}),post=schema.paths['/api/v1/send'].post;
 assert.deepEqual(Object.keys(schema.paths),['/api/v1/send']);assert.equal(post['x-openai-isConsequential'],true);assert.equal(schema.components.securitySchemes.mailflareKey.scheme,'bearer');assert.deepEqual(post.requestBody.content['application/json'].schema.properties.mailboxId.enum,['box']);assert.deepEqual(post.requestBody.content['application/json'].schema.properties.from.enum,['owner@example.test']);assert(!JSON.stringify(schema).includes('ep_'));assert(post.description.includes('never silently send'));
 assert.throws(()=>app.createChatGptSendAction('http://mailflare.test',{id:'box',address:'owner@example.test'}));assert.throws(()=>app.createChatGptSendAction('https://user:password@mailflare.test',{id:'box',address:'owner@example.test'}));
});
test('the real API authenticates the dedicated send key and stores the sent copy without Gmail',async t=>{
 const f=await fixture(t),response=await app.send(f.request());assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert(result.messageId);assert.equal(globalThis.__chatgptDeliveries.length,1);
 const stored=f.DB.db.prepare('SELECT * FROM messages WHERE id=?').get(result.messageId);assert.equal(stored.status,'sent');assert.equal(stored.direction,'outbound');assert.equal(stored.mailbox_id,'box');assert.equal(stored.subject,f.body.subject);assert.equal(stored.text_body,f.body.text);assert(stored.bcc_addr.includes('bcc@example.test'));assert.equal(f.DB.db.prepare('SELECT status FROM outbound_jobs WHERE message_id=?').get(result.messageId).status,'sent');
});
test('out-of-scope mailboxes, read-only keys, disabled owners and revoked keys never deliver',async t=>{
 const f=await fixture(t);assert.equal((await app.send(f.request({},'invalid'))).status,401);assert.equal((await app.send(f.request({mailboxId:'foreign',from:'other@example.test'}))).status,404);
 f.DB.db.exec(`UPDATE api_keys SET scopes='["read"]'`);assert.equal((await app.send(f.request())).status,401);
 f.DB.db.exec(`UPDATE api_keys SET scopes='["send"]';UPDATE users SET disabled=1 WHERE id='owner'`);assert.equal((await app.send(f.request())).status,401);
 f.DB.db.exec(`UPDATE users SET disabled=0 WHERE id='owner';DELETE FROM api_keys`);assert.equal((await app.send(f.request())).status,401);assert.equal(globalThis.__chatgptDeliveries.length,0);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,0);
});
