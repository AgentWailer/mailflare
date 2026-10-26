// Local SQLite adapter only. No production requests or personal messages.
import {build} from 'esbuild';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','navigation-bench-'));
try{
 writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
 await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createSession} from './src/lib/auth/session';export {GET} from './src/app/api/messages/navigation/route';`,resolveDir:process.cwd()},outfile:join(dir,'bench.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
 const app=await import(pathToFileURL(join(dir,'bench.mjs'))),DB=new app.SqliteDatabase(':memory:');
 try{
  await app.applyMigrations(DB,'drizzle/migrations');DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1);INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1);`);
  const insert=DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,read,created_at,thread_id) VALUES(?,'owner','box','inbound','sender@example.test','owner@example.test','Synthetic receipt','received',0,?,?)`);
  DB.db.transaction(()=>{for(let i=0;i<60000;i++)insert.run('mail-'+String(i).padStart(5,'0'),i+1,'thread-'+Math.floor(i/2));})();
  const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;const session=await app.createSession(env,'owner'),results=[];
  for(const grouped of [false,true])for(const concurrency of [1,8]){
   const samples=[];for(let batch=0;batch<5;batch++)await Promise.all(Array.from({length:concurrency},async()=>{const start=performance.now();const response=await app.GET(new Request('https://mailflare.test/api/messages/navigation?mailboxId=box&folder=all&messageId=mail-30000'+(grouped?'&group=thread':''),{headers:{Authorization:'Bearer '+session}}));const text=await response.text();if(response.status!==200)throw Error('Navigation HTTP '+response.status);const parsed=JSON.parse(text);if(parsed.navigation&&(!parsed.navigation.position||parsed.navigation.total!==(grouped?30000:60000)))throw Error('Incorrect navigation window: '+JSON.stringify(parsed.navigation));samples.push({ms:performance.now()-start,bytes:Buffer.byteLength(text),entries:parsed.messages.length,navigation:parsed.navigation});}));
   const p=q=>samples.map(s=>s.ms).sort((a,b)=>a-b)[Math.ceil(samples.length*q)-1];results.push({grouped,concurrency,requests:samples.length,p50:p(.5),p75:p(.75),p95:p(.95),responseBytes:samples[0].bytes,entries:samples[0].entries,navigation:samples[0].navigation});
  }
  const output=process.env.PERF_OUTPUT||'/tmp/mailflare-navigation-benchmark.json';mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({kind:'local SQLite adapter, 60000 synthetic messages; concurrency within one Node process, not Cloudflare CPU or production load',results},null,2));console.log(JSON.stringify(results,null,2));
 }finally{DB.db.close();delete globalThis.__mailflareNodeEnv;}
}finally{rmSync(dir,{recursive:true,force:true});}
