// Native workerd multipart/R2 verification. Synthetic bytes only, no remote bindings.
import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {createHash} from 'node:crypto';
const dir=mkdtempSync(join(process.cwd(),'node_modules','worker-memory-runtime-'));
await build({stdin:{contents:`
 import {readFormDataBody,readArrayBufferBody} from './src/lib/http/request';
 import {RequestBodyTooLargeError} from './src/lib/http/errors';
 export default {async fetch(request,env){try{
  const url=new URL(request.url);
  if(request.method==='GET'){const object=await env.BUCKET.get('copy');return new Response(object.body);}
  if(url.pathname==='/raw'){const bytes=await readArrayBufferBody(request,2048);return Response.json({size:bytes.byteLength});}
  // Exercise the streaming limit as well as the Content-Length preflight in the real Workers parser.
  if(url.pathname==='/small-stream'){const headers=new Headers(request.headers);headers.delete('content-length');request=new Request(request,{headers});}
  const form=await readFormDataBody(request,url.pathname.startsWith('/small')?2048:30*1024*1024),file=form.get('file');
  await env.BUCKET.put('upload',file,{httpMetadata:{contentType:file.type}});
  const object=await env.BUCKET.get('upload');await env.BUCKET.put('copy',object.body);
  const head=await env.BUCKET.head('copy');return Response.json({name:file.name,size:head.size,type:head.httpMetadata.contentType,subject:form.get('subject')});
 }catch(error){return Response.json({error:error.constructor.name,message:error.message},{status:error instanceof RequestBodyTooLargeError?413:400});}}};
 `,resolveDir:process.cwd()},outfile:join(dir,'worker.mjs'),bundle:true,platform:'browser',format:'esm',tsconfig:'tsconfig.json',logLevel:'silent'});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:join(dir,'worker.mjs'),compatibilityDate:'2026-05-20',r2Buckets:['BUCKET'],cf:false,log:new Log(LogLevel.ERROR)}));
after(async()=>{await mf.dispose();rmSync(dir,{recursive:true,force:true});});
test('native Workers parser and R2 accept a 24 MiB File without an extra JS ArrayBuffer and copy it as a stream',async()=>{
 const bytes=new Uint8Array(24*1024*1024);for(let i=0;i<bytes.length;i+=4096)bytes[i]=(i/4096)%256;
 const form=new FormData();form.set('file',new File([bytes],'large.pdf',{type:'application/pdf'}));form.set('subject','Synthetic upload');
 const response=await fetch(new URL('/upload',await mf.ready),{method:'POST',body:form});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.name,'large.pdf');assert.equal(data.size,bytes.length);assert.equal(data.subject,'Synthetic upload');
 const copy=await fetch(new URL('/copy',await mf.ready));const hash=createHash('sha256');for await(const part of copy.body)hash.update(part);assert.equal(hash.digest('hex'),createHash('sha256').update(bytes).digest('hex'));
});
test('native multipart wraps no overflow as a generic parse error, and raw intake is bounded too',async()=>{
 const form=new FormData();form.set('file',new File([new Uint8Array(4096)],'too-large.pdf'));
 // Buffer only this tiny rejection fixture. Node/Undici's multipart writer may still be
 // streaming its closing boundary when workerd cancels an oversized request, causing EPIPE
 // before Node exposes the valid 413 response. The 24 MiB upload above remains streamed.
 const encoded=new Response(form),body=await encoded.arrayBuffer();
 for(const path of ['/small','/small-stream']){
  const multipart=await fetch(new URL(path,await mf.ready),{method:'POST',headers:{'Content-Type':encoded.headers.get('Content-Type')},body});
  const failure=await multipart.json();assert.equal(multipart.status,413,JSON.stringify(failure));assert.equal(failure.error,'RequestBodyTooLargeError');
 }
 const raw=await fetch(new URL('/raw',await mf.ready),{method:'POST',body:new Uint8Array(4096)});assert.equal(raw.status,413);assert.equal((await raw.json()).error,'RequestBodyTooLargeError');
});
