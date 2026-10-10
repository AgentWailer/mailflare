import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const directory=mkdtempSync(join(root,'node_modules','mailflare-refine-test-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
writeFileSync(join(directory,'headers.mjs'), 'export async function cookies() { return { get: name => globalThis.__refineTestCookies?.[name] }; }');
await build({stdin:{contents:`
 export { SqliteDatabase } from './server/runtime/sqlite-database.ts';
 export { applyMigrations } from './server/runtime/migrate.ts';
 export { createSession } from './src/lib/auth/session.ts';
 export { POST } from './src/app/api/compose/refine/route.ts';
 export { refineSchema } from './src/lib/agent/refine-input.ts';
`,resolveDir:root,sourcefile:'refine-api-entry.ts'},outfile:join(directory,'entry.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',tsconfig:join(root,'tsconfig.json'),alias:{'next/headers':join(directory,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(directory,'entry.mjs')).href);
async function fixture(t){
 const database=new app.SqliteDatabase(':memory:');
 t.after(()=>{database.db.close();delete globalThis.__mailflareNodeEnv; delete globalThis.__refineTestCookies;});
 await app.applyMigrations(database,join(root,'drizzle/migrations'));
 database.db.exec(`
 INSERT INTO users (id,email,password_hash,name,created_at) VALUES ('owner','owner@example.test','hash','Owner',1),('reader','reader@example.test','hash','Reader',1),('sender','sender@example.test','hash','Sender',1);
 INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes (id,user_id,domain_id,local_part,type,created_at) VALUES ('mailbox','owner','domain','owner','shared',1);
 INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('read','mailbox','reader','read_only',1),('send','mailbox','sender','send_on_behalf',1);
 `);
 const calls=[];
 let responseText='Guten Tag, können wir uns am Dienstag treffen?'; let finishReason='stop'; let providerError=false;
 const env={DB:database,MAILFLARE_RUNTIME:'node',AI_MODEL:'test-refine-model',AI:{run:async(model,input)=>{
 calls.push({model,input});if(providerError)throw new Error('Test provider unavailable');
 return {choices:[{message:{role:'assistant',content:responseText},finish_reason:finishReason}],usage:{prompt_tokens:25,completion_tokens:15}};
 }}};
 globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['owner','reader','sender'])tokens[id]=await app.createSession(env,id);
 const post=(overrides={},user='owner',headers={})=>app.POST(new Request('https://mailflare.test/api/compose/refine',{method:'POST',headers:{Authorization:`Bearer ${tokens[user]??'invalid'}`,'Content-Type':'application/json',...headers},body:JSON.stringify({mailboxId:'mailbox',text:'Hi can we meet tuesday?',mode:'polish',language:'de',...overrides})}));
 return {database,env,calls,post,tokens,change:(text,finish='stop')=>{responseText=text;finishReason=finish;},failProvider:()=>{providerError=true;}};
}

test('German/English suggestions use the configured provider without modifying or sending mail, and record usage',async(t)=>{
 const f=await fixture(t);
 let r=await f.post();assert.equal(r.status,200);assert.equal((await r.json()).text,'Guten Tag, können wir uns am Dienstag treffen?');
 assert.equal(r.headers.get('Cache-Control'),'no-store');
 assert.equal(f.calls[0].model,'test-refine-model');assert.match(f.calls[0].input.messages[0].content,/Write in German/);
 assert.equal(f.calls[0].input.messages.at(-1).content,'Hi can we meet tuesday?');
 assert.ok(!f.calls[0].input.tools?.length);
 f.change('Hello, could we meet on Tuesday?');r=await f.post({language:'en',mode:'professional'});assert.equal(r.status,200);
 assert.match(f.calls[1].input.messages[0].content,/Write in English/);assert.match(f.calls[1].input.messages[0].content,/professional tone/);
 assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
 assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM outbound_jobs').get().n,0);
 const usage=f.database.db.prepare("SELECT source,input_tokens,output_tokens FROM ai_usage ORDER BY created_at").all();
 assert.equal(usage.length,2);assert.deepEqual(usage[0],{source:'refine',input_tokens:25,output_tokens:15});
});

test('every style and original-language setting have defined prompts',async(t)=>{
 const f=await fixture(t);
 for(const mode of ['polish','professional','friendly','shorter','longer'])assert.equal((await f.post({mode,language:'keep'})).status,200);
 for(const call of f.calls){assert.match(call.input.messages[0].content,/Keep the original language/);assert.match(call.input.messages[0].content,/untrusted source text/);}
});

test('unauthenticated, read-only, disabled-account and unknown-mailbox requests cannot invoke the provider',async(t)=>{
 const f=await fixture(t);
 assert.equal((await f.post({},'unknown')).status,401);
 assert.equal((await f.post({},'reader')).status,403);
 assert.equal((await f.post({mailboxId:'unknown'})).status,403);
 f.database.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");assert.equal((await f.post()).status,401);
 assert.equal(f.calls.length,0);
 assert.equal((await f.post({},'sender')).status,200);
});

test('invalid origin and exhausted rate limiter are rejected before generation',async(t)=>{
 const f=await fixture(t);
 globalThis.__refineTestCookies={ep_session:{value:f.tokens.owner}};
 assert.equal((await f.post({},'owner',{Authorization:'',Origin:'https://foreign.test','Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal(f.calls.length,0);
 f.env.AGENT_RATE_LIMIT={limit:async()=>({success:false})};assert.equal((await f.post()).status,429);
 assert.equal(f.calls.length,0);
});

test('invalid, oversized and malformed payloads do not reach the model',async(t)=>{
 const f=await fixture(t);
 for(const input of [{text:''},{text:'x'.repeat(12001)},{language:'fr'},{mode:'invent'},{protectedTokens:['bad']},{mailboxId:''}])assert.equal((await f.post(input)).status,400);
 assert.equal((await f.post({text:'x'.repeat(81000)})).status,413);
 assert.equal(f.calls.length,0);
});

test('disabled or unconfigured AI cannot be used',async(t)=>{
 const f=await fixture(t);
 f.database.db.exec("UPDATE app_settings SET agent_enabled=0 WHERE id='default'");
 let r=await f.post();assert.equal(r.status,503);assert.equal((await r.json()).code,'disabled');
 f.database.db.exec("UPDATE app_settings SET agent_enabled=1");delete f.env.AI;
 r=await f.post();assert.equal(r.status,503);assert.equal((await r.json()).code,'not_configured');assert.equal(f.calls.length,0);
});

test('empty, truncated, missing-image and provider-error results cannot replace the draft',async(t)=>{
 const f=await fixture(t);
 for(const [text,finish,code] of [['','stop','invalid_output'],['Partial','length','truncated'],['No image','stop','invalid_output']]){
 f.change(text,finish);const token='[[MAILFLARE_IMAGE_abc-123_0]]';
 const r=await f.post(code==='invalid_output'&&text==='No image'?{text:'Please view '+token,protectedTokens:[token]}:{});
 assert.equal(r.status,502);assert.equal((await r.json()).code,code);
 }
 f.failProvider();const r=await f.post();assert.equal(r.status,502);assert.equal((await r.json()).code,'provider_error');
 assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
});

test('image placeholders are preserved in order and duplicate/unknown placeholders are rejected',async(t)=>{
 const f=await fixture(t);const a='[[MAILFLARE_IMAGE_abc-123_0]]',b='[[MAILFLARE_IMAGE_abc-123_1]]';
 const input={text:`See ${a} and ${b}`,protectedTokens:[a,b]};
 f.change(`Please see ${a} and ${b}.`);assert.equal((await f.post(input)).status,200);
 f.change(`${b} ${a}`);assert.equal((await f.post(input)).status,502);
 f.change(`${a} ${a}`);assert.equal((await f.post(input)).status,502);
});
