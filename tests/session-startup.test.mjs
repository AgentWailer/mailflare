import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('',{url:'https://mailflare.test/inbox'});
for(const key of ['window','localStorage','CustomEvent'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-session-startup-'));
after(()=>{dom.window.close();rmSync(dir,{recursive:true,force:true});});
await build({stdin:{contents:`export * from './src/lib/auth/session-client';export {setClientSessionToken,clearClientSessionToken} from './src/lib/auth/client';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const good=id=>Response.json({user:{id,name:id},hasMailboxes:true,isSetup:true});
test('auth guard and startup identity consumers share one successful session validation',async t=>{
 app.clearSessionSnapshot();let calls=0,resolve;t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise(r=>resolve=r);});
 const guard=app.fetchSessionSnapshot(true),consumer=app.fetchSessionSnapshot();assert.equal(calls,1);resolve(good('owner'));
 assert.deepEqual(await guard,await consumer);assert.equal((await app.fetchSessionSnapshot()).data.user.id,'owner');assert.equal(calls,1);
 const fresh=app.fetchSessionSnapshot(true);assert.equal(calls,2,'a new route guard validates live session even while metadata is cached');resolve(good('owner'));await fresh;
});
test('account changes never reuse or cache a pending previous-account response',async t=>{
 app.clearSessionSnapshot();app.setClientSessionToken('old');const resolvers=[];let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise(r=>resolvers.push(r));});
 const old=app.fetchSessionSnapshot();app.setClientSessionToken('new');const next=app.fetchSessionSnapshot();assert.equal(calls,2);
 resolvers[0](good('old'));await old;const joined=app.fetchSessionSnapshot();assert.equal(calls,2);resolvers[1](good('new'));await next;assert.equal((await joined).data.user.id,'new');assert.equal((await app.fetchSessionSnapshot()).data.user.id,'new');
});
test('stale bearer validation falls back to the HttpOnly cookie and errors are never cached',async t=>{
 app.clearSessionSnapshot();app.setClientSessionToken('token');const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push(init);return calls.length===1?new Response('',{status:401}):good('owner');});
 assert.equal((await app.fetchSessionSnapshot()).data.user.id,'owner');assert.equal(calls.length,2);assert.equal(new Headers(calls[0].headers).get('Authorization'),'Bearer token');assert.equal(calls[0].cache,'no-store');
 app.clearSessionSnapshot();let count=0;t.mock.method(globalThis,'fetch',async()=>{count++;return new Response('',{status:503});});
 assert.equal((await app.fetchSessionSnapshot()).status,503);assert.equal((await app.fetchSessionSnapshot()).status,503);assert.equal(count,2);
});
