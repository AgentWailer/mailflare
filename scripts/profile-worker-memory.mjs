/** Synthetic retained-memory probes; these are not live isolate/peak measurements. */
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'mailflare-memory-profile-'));
const sample=String.raw`
 const {pathToFileURL}=await import('node:url');
 const [kind,file]=process.argv.slice(1);
 global.gc();const before=process.memoryUsage();const start=performance.now();const module=await import(pathToFileURL(file));const importMs=performance.now()-start;
 if(kind==='schemas'){
  global.gc();const after=process.memoryUsage();console.log(JSON.stringify({schemas:Object.keys(module).length,retainedHeapBytes:after.heapUsed-before.heapUsed,importMs}));
 }else{
  const source=new Blob(['From sender@example.test Mon Oct 12 12:00:00 2026\nFrom: sender@example.test\nSubject: Synthetic\n\n',new Uint8Array(19*1024*1024),'\n']);
  global.gc();const initial=process.memoryUsage();const iterator=module.readMboxRecords(source);const record=await iterator.next();global.gc();const after=process.memoryUsage();
  console.log(JSON.stringify({rawBytes:record.value.raw.size,retainedArrayBufferBytes:after.arrayBuffers-initial.arrayBuffers,retainedHeapBytes:after.heapUsed-initial.heapUsed}));await iterator.return();
 }
`;
try{
 const result={runtime:process.version,measurement:'local Node retained allocations after GC; not Cloudflare live heap or peak RAM',cases:{}};
 for(const [name,path] of [['schemas','src/lib/validators.ts'],['mbox','src/lib/import/mbox-stream.ts']]){
  const file=join(directory,name+'.mjs');await build({entryPoints:[path],outfile:file,bundle:true,platform:'node',format:'esm',tsconfig:'tsconfig.json',logLevel:'silent'});
  const samples=Array.from({length:5},()=>JSON.parse(execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',sample,name,file],{encoding:'utf8'})));
  const median={};for(const key of Object.keys(samples[0]))median[key]=samples.map(s=>s[key]).sort((a,b)=>a-b)[2];result.cases[name]={median,samples};
 }
 console.log(JSON.stringify(result,null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
