// Exercise the real Workers fetch/stream/WebCrypto implementations, not Node mocks.
import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';

const dir=mkdtempSync(join(process.cwd(),'node_modules','mcp-access-runtime-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`
 import {inspectAccessIdentity} from './src/lib/mcp/access-identity';
 export default {async fetch(request,env){return Response.json(await inspectAccessIdentity(env,request));}};
`,resolveDir:process.cwd()},outfile:join(dir,'worker.mjs'),bundle:true,platform:'browser',format:'esm',tsconfig:'tsconfig.json',logLevel:'silent'});
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicKey={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'runtime-test',alg:'RS256',use:'sig'};
const bindings={MCP_ACCESS_ISSUER:'https://test.cloudflareaccess.com',MCP_ACCESS_AUDIENCE:'a'.repeat(64)};
async function jwt(){
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),now=Math.floor(Date.now()/1000);
 const unsigned=encode({alg:'RS256',kid:publicKey.kid})+'.'+encode({iss:bindings.MCP_ACCESS_ISSUER,aud:[bindings.MCP_ACCESS_AUDIENCE],sub:'synthetic-owner',email:'owner@example.test',type:'app',iat:now-10,exp:now+600});
 return unsigned+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(unsigned))).toString('base64url');
}
function runtime(t,respond){
 const calls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:join(dir,'worker.mjs'),compatibilityDate:'2026-05-20',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],bindings,cf:false,log:new Log(LogLevel.ERROR),outboundService:async request=>{
  calls.push(request.url);assert.equal(request.url,bindings.MCP_ACCESS_ISSUER+'/cdn-cgi/access/certs');
  assert.equal(request.headers.get('Authorization'),null);assert.equal(request.headers.get('Cookie'),null);
  return respond();
 }}));
 t.after(()=>mf.dispose());return {mf,calls};
}
test('native Workers fetch loads bounded signing keys and WebCrypto verifies header and cookie assertions',async t=>{
 const {mf,calls}=runtime(t,()=>Response.json({keys:[publicKey]})),signed=await jwt();
 for(const [source,headers] of [['header',{'Cf-Access-Jwt-Assertion':signed}],['cookie',{Cookie:'CF_Authorization='+signed}]]){
  const check=await (await mf.dispatchFetch('https://mailflare.test/status',{headers})).json();
  assert.equal(check.status,'verified');assert.equal(check.source,source);assert.equal(check.identity.subject,'synthetic-owner');
 }
 assert.equal(calls.length,1,'verified keys are reused within their TTL');
});
test('native Workers rejects certificate redirects without following them or accepting their body',async t=>{
 const {mf,calls}=runtime(t,()=>new Response(JSON.stringify({keys:[publicKey]}),{status:302,headers:{Location:'https://untrusted.example/certs'}}));
 const check=await (await mf.dispatchFetch('https://mailflare.test/status',{headers:{'Cf-Access-Jwt-Assertion':await jwt()}})).json();
 assert.equal(check.status,'certificates_unavailable');assert.equal(check.identity,null);assert.equal(calls.length,1);
});
test('native Workers fails closed when signing certificates exceed the response limit',async t=>{
 const {mf,calls}=runtime(t,()=>new Response(' '.repeat(129*1024)));
 const check=await (await mf.dispatchFetch('https://mailflare.test/status',{headers:{'Cf-Access-Jwt-Assertion':await jwt()}})).json();
 assert.equal(check.status,'certificates_unavailable');assert.equal(check.identity,null);assert.equal(calls.length,1);
});
