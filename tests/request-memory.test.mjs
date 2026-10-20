import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=mkdtempSync(join(process.cwd(),'node_modules','request-memory-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export * from './src/lib/http/request';export * from './src/lib/http/errors';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',tsconfig:'tsconfig.json',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
function endless(headers={}) {
 let reads=0,cancelled=false;
 const body=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(1024));},cancel(){cancelled=true;}},{highWaterMark:0});
 return {request:new Request('https://mailflare.test/upload',{method:'POST',headers,body,duplex:'half'}),reads:()=>reads,cancelled:()=>cancelled};
}
for(const [name,reader,headers] of [
 ['JSON',app.readJsonBody,{'Content-Type':'application/json'}],
 ['multipart',app.readFormDataBody,{'Content-Type':'multipart/form-data; boundary=test'}],
 ['raw mail',app.readArrayBufferBody,{}],
]) for(const length of [undefined,'1','not-a-number']) test(`${name} cancels oversized streams with Content-Length ${length??'missing'}`,async()=>{
 const f=endless({...headers,...(length?{'Content-Length':length}:{})});
 await assert.rejects(()=>reader(f.request,2048),app.RequestBodyTooLargeError);
 assert(f.cancelled(),'source is cancelled, rather than read to EOF');assert.equal(f.reads(),3,'at most the limit plus one incoming chunk is read');
});
test('declared oversized requests are rejected before any bytes are read',async()=>{
 const f=endless({'Content-Length':'4096'});await assert.rejects(()=>app.readJsonBody(f.request,2048),app.RequestBodyTooLargeError);assert.equal(f.reads(),0);assert(f.cancelled());
});
test('JSON byte limits preserve empty bodies, Unicode and syntax errors',async()=>{
 assert.deepEqual(await app.readJsonBody(new Request('http://x',{method:'POST'}),0),{});
 const text='{"name":"Grüße"}',size=new TextEncoder().encode(text).length;
 assert.deepEqual(await app.readJsonBody(new Request('http://x',{method:'POST',body:text}),size),{name:'Grüße'});
 await assert.rejects(()=>app.readJsonBody(new Request('http://x',{method:'POST',body:text}),size-1),app.RequestBodyTooLargeError);
 await assert.rejects(()=>app.readJsonBody(new Request('http://x',{method:'POST',body:'{'}),10),SyntaxError);
});
test('multipart keeps fields, filenames, repeated attachments and exact file bytes without prebuffering the request',async()=>{
 const form=new FormData();form.set('subject','Rechnung');form.append('attachments',new File([new Uint8Array([0,128,255])],'a.pdf',{type:'application/pdf'}));form.append('attachments',new File(['hello'],'b.txt',{type:'text/plain'}));
 const request=new Request('http://x',{method:'POST',body:form});request.arrayBuffer=()=>{throw Error('full request buffering is forbidden');};
 const parsed=await app.readFormDataBody(request,4096);assert.equal(parsed.get('subject'),'Rechnung');const [a,b]=parsed.getAll('attachments');assert.equal(a.name,'a.pdf');assert.equal(a.type,'application/pdf');assert.deepEqual(new Uint8Array(await a.arrayBuffer()),new Uint8Array([0,128,255]));assert.equal(await b.text(),'hello');
});
test('URL encoded forms and upstream stream failures preserve their semantics',async()=>{
 const form=await app.readFormDataBody(new Request('http://x',{method:'POST',body:new URLSearchParams({name:'Mailflare'})}),100);assert.equal(form.get('name'),'Mailflare');
 const request=new Request('http://x',{method:'POST',body:new ReadableStream({pull(c){c.error(new Error('connection interrupted'));}}),duplex:'half'});await assert.rejects(()=>app.readArrayBufferBody(request,100),/connection interrupted/);
});
