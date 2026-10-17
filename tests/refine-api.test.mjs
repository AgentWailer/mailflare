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
 assert.equal((await f.post({text:'x'.repeat(410000)})).status,413);
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


function addHistoryMail(f, overrides={}) {
 const mail={id:'source',user:'owner',mailbox:'mailbox',direction:'inbound',from:'Julia <julia@example.test>',to:'owner@example.test',subject:'Next steps',text:'Can we discuss the next steps?',html:null,status:'received',thread:'thread',provider:'source@example.test',created:1,...overrides};
 f.database.db.prepare('INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,html_body,status,thread_id,provider_message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(mail.id,mail.user,mail.mailbox,mail.direction,mail.from,mail.to,mail.subject,mail.text,mail.html,mail.status,mail.thread,mail.provider,mail.created);
}
const replyInput={action:'reply',text:'',replyContext:{threadId:'thread',inReplyTo:'<source@example.test>',from:'owner@example.test',to:'julia@example.test',subject:'Re: Next steps'}};

test('empty-body suggestions read the complete thread in chronological order, excluding drafts and unrelated conversations',async(t)=>{
 const f=await fixture(t);
 // More than one database page: older messages must not silently disappear.
 for(let i=0;i<55;i++)addHistoryMail(f,{id:`history-${i}`,provider:`mail-${i}@example.test`,created:i+1,text:`History message ${i}`,direction:i%2?'outbound':'inbound',status:i%2?'sent':'received'});
 addHistoryMail(f,{created:56,text:'Can you summarize our agreed next steps?'});
 addHistoryMail(f,{id:'other-draft',user:'reader',status:'draft',text:'Private unsent draft',created:57});
 addHistoryMail(f,{id:'own-draft',status:'draft',text:'Own uncommitted draft',created:58});
 addHistoryMail(f,{id:'unrelated',thread:'another-thread',text:'Unrelated content',created:59});
 const before=f.database.db.prepare('SELECT * FROM messages ORDER BY id').all();
 const response=await f.post(replyInput);assert.equal(response.status,200);
 const prompt=f.calls[0].input.messages;assert.match(prompt[0].content,/draft an email reply/);assert.match(prompt[0].content,/entire supplied conversation/);assert.match(prompt[0].content,/Write in German/);
 const context=JSON.parse(prompt.at(-1).content);assert.equal(context.conversation.length,56);assert.equal(context.conversation[0].text,'History message 0');assert.equal(context.conversation.at(-1).text,'Can you summarize our agreed next steps?');
 assert.equal(context.to,'julia@example.test');assert.ok(!JSON.stringify(context).includes('Private unsent'));assert.ok(!JSON.stringify(context).includes('Unrelated content'));
 assert.deepEqual(f.database.db.prepare('SELECT * FROM messages ORDER BY id').all(),before);assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM outbound_jobs').get().n,0);
});

test('reply history checks source-mailbox read access separately from sending permissions',async(t)=>{
 const f=await fixture(t);
 f.database.db.exec("INSERT INTO mailboxes (id,user_id,domain_id,local_part,type,created_at) VALUES ('private','owner','domain','private','personal',1),('allowed','owner','domain','allowed','shared',1); INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('source-read','allowed','sender','read_only',1);");
 addHistoryMail(f,{mailbox:'private'});
 let response=await f.post({...replyInput,replyContext:{...replyInput.replyContext,mailboxId:'private'}},'sender');assert.equal(response.status,403);assert.equal(f.calls.length,0);
 f.database.db.exec("UPDATE messages SET mailbox_id='allowed'");
 response=await f.post({...replyInput,replyContext:{...replyInput.replyContext,mailboxId:'allowed'}},'sender');assert.equal(response.status,200);assert.equal(f.calls.length,1);
 response=await f.post(replyInput,'reader');assert.equal(response.status,403);assert.equal(f.calls.length,1);
});

test('missing or inconsistent history and oversized complete conversations never invoke the provider',async(t)=>{
 const f=await fixture(t);
 let r=await f.post(replyInput);assert.equal(r.status,404);assert.equal((await r.json()).code,'history_missing');
 addHistoryMail(f);
 r=await f.post({...replyInput,replyContext:{...replyInput.replyContext,threadId:'wrong-thread'}});assert.equal(r.status,404);
 r=await f.post({action:'reply',text:'',replyContext:{}});assert.equal(r.status,400);
 f.database.db.exec("UPDATE messages SET text_body='"+'x'.repeat(60001)+"'");
 r=await f.post(replyInput);assert.equal(r.status,413);assert.equal((await r.json()).code,'history_too_long');assert.equal(f.calls.length,0);
});

test('legacy single-message replies and quoted-history fallback use reply prompts with original-language settings',async(t)=>{
 const f=await fixture(t);addHistoryMail(f,{thread:null,text:null,html:'<p>Could you send the report?</p>'});
 let response=await f.post({action:'reply',text:'',language:'keep',replyContext:{inReplyTo:'source@example.test',threadId:'source@example.test'}});assert.equal(response.status,200);
 assert.match(f.calls[0].input.messages[0].content,/language of the latest email/);
 assert.equal(JSON.parse(f.calls[0].input.messages.at(-1).content).conversation[0].text,'Could you send the report?');
 response=await f.post({action:'reply',text:'',replyContext:{quotedText:'On Monday Julia wrote: Could we discuss the proposal?'}});assert.equal(response.status,200);
 assert.equal(JSON.parse(f.calls[1].input.messages.at(-1).content).conversation[0].text,'On Monday Julia wrote: Could we discuss the proposal?');
 assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
});


test('writing instructions create or edit a body without changing recipients, sending mail or saving server drafts',async t=>{
 const f=await fixture(t);let response=await f.post({action:'compose',text:'',instruction:'Thank Julia for the meeting.',language:'keep'});assert.equal(response.status,200);
 const messages=f.calls[0].input.messages;assert.match(messages[0].content,/draft an email body/);assert.match(messages[0].content,/language of the writing instruction/);assert.equal(JSON.parse(messages.at(-1).content).userInstruction,'Thank Julia for the meeting.');
 response=await f.post({instruction:'Make this shorter and friendlier.'});assert.equal(response.status,200);assert.match(f.calls[1].input.messages[0].content,/separate userInstruction/);assert.equal(JSON.parse(f.calls[1].input.messages.at(-1).content).originalBody,'Hi can we meet tuesday?');
 for(const input of [{action:'compose',text:'',instruction:''},{instruction:'x'.repeat(2001)}])assert.equal((await f.post(input)).status,400);
 assert.equal((await f.post({action:'compose',text:'',instruction:'A short greeting'},'reader')).status,403);
 assert.equal(f.database.db.prepare('SELECT count(*) n FROM messages').get().n,0);assert.equal(f.database.db.prepare('SELECT count(*) n FROM outbound_jobs').get().n,0);
});
