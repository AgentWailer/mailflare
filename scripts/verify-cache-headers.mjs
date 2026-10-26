// Actual preview HTTP responses, not route mocks. Never contacts production.
import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{createServer}from'node:net';import{mkdtempSync,rmSync,readdirSync,mkdirSync,writeFileSync}from'node:fs';import{tmpdir}from'node:os';import{join,dirname}from'node:path';
const temporary=mkdtempSync(join(tmpdir(),'mailflare-cache-')),reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin=`http://127.0.0.1:${port}`,pause=ms=>new Promise(r=>setTimeout(r,ms));let preview,logs='';
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const s of [preview.stdout,preview.stderr])s.on('data',b=>logs+=b);
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 const chunk=readdirSync('dist/client/_next/static/chunks').find(n=>n.startsWith('framework-')&&n.endsWith('.js')),report=[];
 for(const [path,pattern]of [[`/_next/static/chunks/${chunk}`,/max-age=31536000.*immutable/],['/sw.js',/no-cache/],['/locales/de.json',/max-age=0.*must-revalidate/],['/manifest.webmanifest',/no-cache/],['/inbox',/(?=.*\bprivate\b)(?=.*\bno-store\b)/],['/api/auth/me',/(?=.*\bprivate\b)(?=.*\bno-store\b)/]]){
  const response=await fetch(origin+path),cacheControl=response.headers.get('cache-control'),etag=response.headers.get('etag');await response.body?.cancel();assert.match(cacheControl??'',pattern,path);
  let repeatStatus;if(etag){const repeat=await fetch(origin+path,{headers:{'If-None-Match':etag}});repeatStatus=repeat.status;await repeat.body?.cancel();if(path.startsWith('/_next/static/')||path==='/locales/de.json')assert.equal(repeatStatus,304,path+' revalidates');}
  report.push({path,status:response.status,cacheControl,etag:!!etag,repeatStatus});
 }
 for(const actor of ['a','b']){const r=await fetch(origin+'/inbox',{headers:{Cookie:'ep_session=synthetic-'+actor,Authorization:'Bearer synthetic-'+actor}});assert.match(r.headers.get('cache-control'),/(?=.*\bprivate\b)(?=.*\bno-store\b)/);await r.body?.cancel();}
 const output=process.env.PERF_CACHE_OUTPUT||'/tmp/mailflare-cache-verification.json';mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{if(preview){preview.kill('SIGTERM');await new Promise(r=>{if(preview.exitCode!==null)return r();preview.once('exit',r);setTimeout(()=>{preview.kill('SIGKILL');r();},5000).unref();});}writeFileSync('/tmp/mailflare-cache-preview.log',logs);rmSync(temporary,{recursive:true,force:true});}
