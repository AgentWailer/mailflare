import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-logo-test-'));
after(() => rmSync(dir, {recursive:true, force:true}));
await build({stdin:{contents:"export {getCachedSenderLogo} from './src/lib/contacts/logo-cache.ts'; export {senderLogoDomain,knownSenderLogo} from './src/lib/contacts/sender-logos.ts';",resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const {getCachedSenderLogo,senderLogoDomain,knownSenderLogo} = await import(pathToFileURL(join(dir,'app.mjs')).href);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==','base64');
function bucket(){const objects=new Map();return {objects,get:async key=>objects.get(key)??null,put:async(key,data,options)=>{const bytes=typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data);objects.set(key,{customMetadata:options?.customMetadata,arrayBuffer:async()=>bytes.slice().buffer});}};}
function upstream(t,fn){const previous=globalThis.fetch;globalThis.fetch=fn;t.after(()=>globalThis.fetch=previous);}
test('known logos match real domains and their subdomains, never display names or lookalikes',()=>{
 assert.equal(knownSenderLogo('Cloudflare <billing@email.cloudflare.com>'),'cloudflare');
 assert.equal(knownSenderLogo('receipts@uber.com'),'uber');assert.equal(knownSenderLogo('orders@amazon.de'),'amazon');assert.equal(knownSenderLogo('chat@openai.com'),'openai');
 for(const address of ['Cloudflare <sender@unrelated.com>','sender@cloudflare.com.evil.com','sender@fakecloudflare.com'])assert.equal(knownSenderLogo(address),null);
 for(const address of ['person@gmail.com','person@icloud.com','x@127.0.0.1','x@localhost','x@private.internal','x@company.test','x@evil.com/a','x@y@domain.com','x@evil.com:443','x@-evil.com'])assert.equal(senderLogoDomain(address),null);
 assert.equal(senderLogoDomain('Person <a@company.co.uk>'),'company.co.uk');
});
test('first discovery persists per account and domain; concurrent and later requests reuse it',async t=>{
 const store=bucket(),requests=[];upstream(t,async(url,options)=>{requests.push(String(url));assert.equal(options.redirect,'manual');await new Promise(resolve=>setTimeout(resolve,10));return new Response(png,{headers:{'Content-Type':'image/png'}});});
 const [first,second]=await Promise.all([getCachedSenderLogo(store,'owner','company.com'),getCachedSenderLogo(store,'owner','company.com')]);assert.deepEqual(Buffer.from(first),png);assert.deepEqual(Buffer.from(second),png);assert.equal(requests.length,1);
 assert.deepEqual(Buffer.from(await getCachedSenderLogo(store,'owner','company.com')),png);assert.equal(requests.length,1);
 const url=new URL(requests[0]);assert.equal(url.hostname,'www.google.com');assert.equal(url.searchParams.get('domain'),'company.com');assert(!requests[0].includes('@'));
 await getCachedSenderLogo(store,'another','company.com');assert.equal(requests.length,2);assert.equal(store.objects.size,2);
});
test('missing logos use negative cache and retry after its expiry',async t=>{
 const store=bucket();let requests=0;upstream(t,async()=>{requests++;return new Response('',{status:404});});
 assert.equal(await getCachedSenderLogo(store,'negative','absent.com'),null);assert.equal(await getCachedSenderLogo(store,'negative','absent.com'),null);assert.equal(requests,1);
 store.objects.get('sender-logos/negative/absent.com.missing').customMetadata.expiresAt='0';await getCachedSenderLogo(store,'negative','absent.com');assert.equal(requests,2);
});
test('only trusted provider redirects are followed',async t=>{
 const store=bucket(),requests=[];upstream(t,async url=>{requests.push(String(url));return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});});
 assert.equal(await getCachedSenderLogo(store,'redirect','company.com'),null);assert.equal(requests.length,1);
});
test('trusted provider redirects deliver cached PNG artwork',async t=>{
 const store=bucket(),requests=[];upstream(t,async url=>{requests.push(String(url));return requests.length===1?new Response(null,{status:302,headers:{Location:'https://t1.gstatic.com/favicon.png'}}):new Response(png,{headers:{'Content-Type':'image/png'}});});
 assert.deepEqual(Buffer.from(await getCachedSenderLogo(store,'trusted','company.com')),png);assert.equal(requests.length,2);
});
test('SVG, oversized bodies and malformed PNG dimensions fall back to initials',async t=>{
 const store=bucket();let answer;upstream(t,async()=>answer());
 for(const [owner,body,type] of [['svg','<svg onload="alert(1)"/>','image/svg+xml'],['fake','<svg/>','image/png'],['oversized',new Uint8Array(129*1024),'image/png'],['dimensions',Buffer.from(png),'image/png']]){
  if(owner==='dimensions')body.writeUInt32BE(65535,16);
  answer=()=>new Response(body,{headers:{'Content-Type':type}});assert.equal(await getCachedSenderLogo(store,owner,'company.com'),null);assert.equal(store.objects.has(`sender-logos/${owner}/company.com.png`),false);
 }
});
test('network failures retain the initial and avoid repeatedly calling the provider',async t=>{
 const store=bucket();let requests=0;upstream(t,async()=>{requests++;throw new Error('network unavailable');});
 assert.equal(await getCachedSenderLogo(store,'offline','company.com'),null);assert.equal(await getCachedSenderLogo(store,'offline','company.com'),null);assert.equal(requests,1);
});
