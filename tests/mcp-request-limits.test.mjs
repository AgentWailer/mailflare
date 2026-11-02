import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mcp-limits-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
await build({entryPoints:['src/lib/mcp/request-limits.ts'],outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',tsconfig:'tsconfig.json',logLevel:'silent'});
const {boundedMcpRequest,MCP_REQUEST_BYTES}=await import(pathToFileURL(join(dir,'app.mjs')));
const request=body=>new Request('https://mailflare.test/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic'},body});
test('normal MCP call is preserved with its authentication and JSON text',async()=>{
 const payload={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_mailboxes',arguments:{}}};
 const result=await boundedMcpRequest(request(JSON.stringify(payload)));assert.deepEqual(await result.json(),payload);assert.equal(result.headers.get('Authorization'),'Bearer synthetic');
});
test('oversized streamed JSON without content length is rejected before SDK parsing',async()=>{
 const encoder=new TextEncoder();let cancelled=false;
 const body=new ReadableStream({pull(c){c.enqueue(encoder.encode('x'.repeat(64*1024)));},cancel(){cancelled=true;}});
 await assert.rejects(boundedMcpRequest(new Request('https://mailflare.test/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'})),/too large/);assert(cancelled);
 assert.equal(MCP_REQUEST_BYTES,1024*1024);
});
test('deep, wide, malformed and invalid UTF-8 payloads are bounded',async()=>{
 await assert.rejects(boundedMcpRequest(request('['.repeat(40)+'0'+']'.repeat(40))),/complex/);
 await assert.rejects(boundedMcpRequest(request(JSON.stringify(Array(10001).fill(0)))),/complex/);
 await assert.rejects(boundedMcpRequest(request('{')));
 await assert.rejects(boundedMcpRequest(request(new Uint8Array([0xff]))));
});
test('GET transport remains bodyless and unchanged',async()=>{
 const input=new Request('https://mailflare.test/mcp');assert.equal(await boundedMcpRequest(input),input);
});
