import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mcp-oauth-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),"export async function cookies(){return {get:name=>name==='ep_session'&&globalThis.__mcpTestCookie?{value:globalThis.__mcpTestCookie}:undefined};}");
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createSession,getUserFromSession} from './src/lib/auth/session';
 export {generateApiKey} from './src/lib/api-keys';export {getDb} from './src/db';export {authenticateMcpRequest,getMcpAuthentication} from './src/lib/mcp/auth';export * from './src/lib/mcp/access-identity';export * from './src/lib/mcp/oauth-grants';
 export {POST as rpc} from './src/app/mcp/route';export {GET as status,POST as consent} from './src/app/api/settings/mcp-oauth/route';export {DELETE as revokeKey} from './src/app/api/agent/mcp-keys/route';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export';export {buildMcpAgentPrompt} from './src/components/settings/mcp-agent-instructions-utils';
`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicKey={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'cloudflare-test',alg:'RS256',use:'sig'};
let fixtureCounter=0;
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,'drizzle/migrations');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__mcpTestCookie;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1),('private','owner','domain','private','personal',1),('foreign','other','domain','other','personal',1);`);
 const key=app.generateApiKey(),other=app.generateApiKey();
 const insert=DB.db.prepare("INSERT INTO api_keys(id,user_id,name,prefix,key_hash,scopes,kind,created_at) VALUES(?,?,?,?,?,?,'mcp',1)");
 insert.run('key','owner','ChatGPT',key.prefix,key.hash,'["mcp:read","mcp:draft","mcp:request-send","mcp:calendar-read"]');insert.run('other-key','other','Other',other.prefix,other.hash,'["mcp:read"]');
 DB.db.exec("INSERT INTO mcp_key_mailboxes(key_id,mailbox_id) VALUES('key','box'),('other-key','foreign')");
 const env={DB,MAILFLARE_RUNTIME:'node',APP_URL:'https://mailflare.test',MCP_ACCESS_ISSUER:`https://team-${++fixtureCounter}.cloudflareaccess.com`,MCP_ACCESS_AUDIENCE:'a'.repeat(64)};globalThis.__mailflareNodeEnv=env;
 const sessions={};for(const actor of ['owner','other'])sessions[actor]=await app.createSession(env,actor);
 const user=await app.getUserFromSession(env,sessions.owner),calls=[],state={keys:[publicKey],failure:false,oversized:false};
 t.mock.method(globalThis,'fetch',async(input,options={})=>{calls.push({url:String(input),options});assert.equal(String(input),env.MCP_ACCESS_ISSUER+'/cdn-cgi/access/certs');if(state.failure)return new Response(null,{status:503});if(state.oversized)return new Response('x'.repeat(129*1024));return Response.json({keys:state.keys});});
 async function jwt(overrides={},headerOverrides={},signingKey=pair.privateKey){const now=Math.floor(Date.now()/1000),claims={iss:env.MCP_ACCESS_ISSUER,aud:[env.MCP_ACCESS_AUDIENCE],sub:'google-person',email:'google-login@example.test',type:'app',iat:now-10,exp:now+3600,...overrides};const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),header=encode({alg:'RS256',kid:'cloudflare-test',...headerOverrides}),payload=encode(claims),signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',signingKey,new TextEncoder().encode(header+'.'+payload));return header+'.'+payload+'.'+Buffer.from(signature).toString('base64url');}
 const assertion=await jwt();
 const browser=(body,actor='owner',signed=assertion)=>new Request('https://mailflare.test/api/settings/mcp-oauth',{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+sessions[actor],'Content-Type':'application/json',...(signed?{'Cf-Access-Jwt-Assertion':signed}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const request=(signed=assertion,token='oauth:opaque-client-token')=>new Request('https://mailflare.test/mcp',{headers:{...(token?{Authorization:'Bearer '+token}:{}),...(signed?{'Cf-Access-Jwt-Assertion':signed}:{})}});
 const enable=async()=>{const response=await app.consent(browser({enabled:true,keyId:'key'}));assert.equal(response.status,200,await response.clone().text());return response.json();};
 return {DB,env,key,other,sessions,user,calls,state,jwt,assertion,browser,request,enable};
}
test('Access user assertions require RS256, the exact issuer/audience, valid times and a verifiable user identity',async t=>{
 const f=await fixture(t);assert.deepEqual(await app.verifyAccessIdentity(f.env,f.request()),{issuer:f.env.MCP_ACCESS_ISSUER,subject:'google-person',email:'google-login@example.test'});
 for(const claims of [{iss:'https://attacker.cloudflareaccess.com'},{aud:['b'.repeat(64)]},{exp:1},{iat:Math.floor(Date.now()/1000)+60},{nbf:Math.floor(Date.now()/1000)+60},{email:undefined},{sub:undefined},{common_name:'service-token'},{email_verified:false},{type:'service'}])assert.equal(await app.verifyAccessIdentity(f.env,f.request(await f.jwt(claims))),null,JSON.stringify(claims));
 assert.equal(await app.verifyAccessIdentity(f.env,f.request(await f.jwt({}, {alg:'HS256'}))),null);assert.equal(await app.verifyAccessIdentity(f.env,f.request(await f.jwt({}, {alg:'none'}))),null);
 const pieces=f.assertion.split('.');pieces[1]=Buffer.from(JSON.stringify({iss:f.env.MCP_ACCESS_ISSUER,aud:[f.env.MCP_ACCESS_AUDIENCE],sub:'attacker',email:'attacker@example.test',type:'app',iat:1,exp:9999999999})).toString('base64url');assert.equal(await app.verifyAccessIdentity(f.env,f.request(pieces.join('.'))),null);
 assert.equal(await app.verifyAccessIdentity(f.env,f.request('x'.repeat(17000))),null);assert.equal(f.calls.length,1,'invalid assertions do not repeatedly fetch certificates');
 assert.equal(app.mcpAccessConfiguration({...f.env,MCP_ACCESS_ISSUER:'https://attacker.invalid'}).configured,false);assert.equal(app.mcpAccessConfiguration({...f.env,MCP_ACCESS_ISSUER:f.env.MCP_ACCESS_ISSUER+'/path'}).configured,false);
});
test('an explicit dual-login grant binds a stable Access subject to one owned MCP key, including differing login emails',async t=>{
 const f=await fixture(t);assert.equal((await app.getMcpAuthentication(f.env,f.request())).reason,'grant_required');
 const status=await f.enable();assert(status.grant.enabled);assert.equal(status.identity.email,'google-login@example.test');assert.notEqual(status.identity.email,f.user.email);
 const principal=await app.authenticateMcpRequest(f.env,f.request());assert.equal(principal.user.id,'owner');assert.equal(principal.keyId,'key');assert.deepEqual(principal.mailboxIds,['box']);assert(principal.scopes.includes('mcp:calendar-read'));assert(!principal.scopes.includes('mcp:calendar-write'));
 assert.equal((await app.authenticateMcpRequest(f.env,f.request(f.assertion,null))).keyId,'key','the origin relies on the verified assertion, not whether Access forwards its opaque Authorization token');
 const changed=await f.jwt({email:'new-email@example.test'});assert.equal(await app.authenticateMcpRequest(f.env,f.request(changed)),null);assert.equal(await app.authenticateMcpRequest(f.env,f.request(await f.jwt({sub:'other-person'}))),null);
 const other=await app.consent(f.browser({enabled:true,keyId:'other-key'},'other'));assert.equal(other.status,400);assert.equal((await other.json()).error,'identity_already_linked');
});
test('consent rejects anonymous/cross-site requests, missing assertions, foreign keys and administrative scopes',async t=>{
 const f=await fixture(t);assert.equal((await app.consent(f.browser({enabled:true,keyId:'other-key'}))).status,400);assert.equal((await app.consent(f.browser({enabled:true,keyId:'key'},'owner',null))).status,400);
 const anonymous=new Request('https://mailflare.test/api/settings/mcp-oauth',{method:'POST',headers:{'Content-Type':'application/json','Cf-Access-Jwt-Assertion':f.assertion},body:JSON.stringify({enabled:true,keyId:'key'})});assert.equal((await app.consent(anonymous)).status,401);
 globalThis.__mcpTestCookie=f.sessions.owner;const crossSite=new Request(anonymous,{headers:{'Content-Type':'application/json',Origin:'https://evil.test','Cf-Access-Jwt-Assertion':f.assertion}});assert.equal((await app.consent(crossSite)).status,403);delete globalThis.__mcpTestCookie;
 f.DB.db.exec(`UPDATE api_keys SET scopes='["domains"]' WHERE id='key'`);assert.equal((await app.consent(f.browser({enabled:true,keyId:'key'}))).status,400);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mcp_oauth_grants').get().n,0);
});
test('revocation, disabled accounts, deleted keys and changing mailbox permissions apply immediately to OAuth calls',async t=>{
 const f=await fixture(t);await f.enable();f.DB.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='box'");assert.deepEqual((await app.authenticateMcpRequest(f.env,f.request())).mailboxIds,[]);
 f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");assert.equal(await app.authenticateMcpRequest(f.env,f.request()),null);f.DB.db.exec("UPDATE users SET disabled=0 WHERE id='owner'");
 assert.equal((await app.consent(f.browser({enabled:false},'owner',null))).status,200,'the local owner can revoke even if the Access assertion is unavailable');assert.equal(await app.authenticateMcpRequest(f.env,f.request()),null);
 await f.enable();f.DB.db.exec("UPDATE api_keys SET scopes='[\"domains\"]' WHERE id='key'");assert.equal(await app.authenticateMcpRequest(f.env,f.request()),null);f.DB.db.exec("UPDATE api_keys SET scopes='[\"mcp:read\"]' WHERE id='key'");
 const response=await app.revokeKey(new Request('https://mailflare.test/api/agent/mcp-keys?id=key',{method:'DELETE',headers:{Authorization:'Bearer '+f.sessions.owner}}));assert.equal(response.status,200);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mcp_oauth_grants').get().n,0);assert.equal(await app.authenticateMcpRequest(f.env,f.request()),null);
});
test('legacy Bearer keys retain their scopes and invalid keys never fall back to OAuth grants',async t=>{
 const f=await fixture(t);await f.enable();assert.equal((await app.authenticateMcpRequest(f.env,f.request(null,f.key.fullKey))).keyId,'key');assert.equal(await app.authenticateMcpRequest(f.env,f.request(f.assertion,'ep_invalid-key')),null);
 const value=await (await app.status(f.browser())).json();assert(!JSON.stringify(value).includes(f.key.fullKey));assert(!JSON.stringify(value).includes(f.assertion));assert(!('subject' in value.identity));
});
test('the actual MCP handshake, get_calendars and list_mailboxes work using OAuth identity and remain mailbox scoped',async t=>{
 const f=await fixture(t);await f.enable();let sequence=0;
 async function rpc(method,params){const response=await app.rpc(new Request('https://mailflare.test/mcp',{method:'POST',headers:{Authorization:'Bearer oauth:opaque','Cf-Access-Jwt-Assertion':f.assertion,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})}));assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert(response.headers.get('Vary').includes('Authorization'));const text=await response.text(),data=response.headers.get('Content-Type')?.includes('text/event-stream')?text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim())).find(value=>value.id===sequence):JSON.parse(text);assert(data);assert(!data.error,JSON.stringify(data));return data.result;}
 const initialized=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'oauth-test',version:'1'}});assert.equal(initialized.serverInfo.name,'mailflare');
 const tools=(await rpc('tools/list',{})).tools;assert(tools.some(tool=>tool.name==='request_send'));assert(!tools.some(tool=>/^send_email$|^send_mail$/.test(tool.name)));
 for(const name of ['get_calendars','list_mailboxes'])assert(tools.some(tool=>tool.name===name));
 const mailboxes=JSON.parse((await rpc('tools/call',{name:'list_mailboxes',arguments:{}})).content[0].text);assert.deepEqual(mailboxes.map(mailbox=>mailbox.id),['box']);
 const calendars=await rpc('tools/call',{name:'get_calendars',arguments:{}});assert(!calendars.isError,JSON.stringify(calendars));assert.deepEqual(JSON.parse(calendars.content[0].text).calendars.map(calendar=>calendar.id),['personal']);
 const calendarWrite=await rpc('tools/call',{name:'create_event',arguments:{title:'Must not be created',startsAt:'2026-10-29T12:00:00Z',endsAt:'2026-10-29T13:00:00Z'}});assert(calendarWrite.isError);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM calendar_events').get().n,0);
 const denied=await rpc('tools/call',{name:'get_email',arguments:{mailboxId:'private',messageId:'anything'}});assert(denied.isError);
});
test('unknown certificate IDs have a refresh cooldown, legitimate rotation refreshes once, expired cached keys fail closed',async t=>{
 const f=await fixture(t);await app.verifyAccessIdentity(f.env,f.request());for(let i=0;i<10;i++)assert.equal(await app.verifyAccessIdentity(f.env,f.request(await f.jwt({}, {kid:'unknown-'+i}))),null);assert.equal(f.calls.length,1);
 const rotate=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);f.state.keys=[{...await crypto.subtle.exportKey('jwk',rotate.publicKey),kid:'rotated',alg:'RS256',use:'sig'}];const base=Date.now();t.mock.method(Date,'now',()=>base+61_000);
 assert(await app.verifyAccessIdentity(f.env,f.request(await f.jwt({}, {kid:'rotated'},rotate.privateKey))));assert.equal(f.calls.length,2);
 t.mock.method(Date,'now',()=>base+400_000);f.state.failure=true;assert.equal(await app.verifyAccessIdentity(f.env,f.request(await f.jwt({}, {kid:'rotated'},rotate.privateKey))),null);assert.equal(f.calls.length,3);
});
test('oversized certificate responses are rejected and cached certificate state remains bounded',async t=>{
 const f=await fixture(t);f.state.oversized=true;assert.equal(await app.verifyAccessIdentity(f.env,f.request()),null);assert.equal(f.calls.length,1);
});
test('backup/restore keeps identity bindings and permissions but requires explicit OAuth reactivation',async t=>{
 const f=await fixture(t);await f.enable();const bytes=await app.exportDatabaseRecords(f.DB);await app.restoreDatabaseRecords(f.DB,bytes.buffer);assert.equal(f.DB.db.prepare('SELECT enabled FROM mcp_oauth_grants').get().enabled,0);assert.equal(await app.authenticateMcpRequest(f.env,f.request()),null);await f.enable();assert(await app.authenticateMcpRequest(f.env,f.request()));
});
test('copied connection instructions never embed the key and explain the separate OAuth registration step',()=>{
 for(const mode of ['mail','admin']){const text=app.buildMcpAgentPrompt('https://mailflare.test',{mode,apiKey:'ep_secret-must-never-be-copied'});assert(!text.includes('ep_secret-must-never-be-copied'));assert(text.includes('https://mailflare.test/mcp'));assert(text.includes('\nServer URL:'));if(mode==='mail'){assert(text.includes('OAuth'));assert(text.includes('does not register'));}}
});
