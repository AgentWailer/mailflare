// Controlled local regression benchmark; no production requests or real mail.
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','message-read-bench-'));
const delay=Number(process.env.HEADER_DELAY_MS||1000),rounds=5;
let DB;
try{
 await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {getMessageWithBodyForUser} from './src/lib/email/inbound';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
 const app=await import(pathToFileURL(join(dir,'app.mjs')));DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('owner','owner@example.test','hash','Owner','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,text_body,html_body,raw_r2_key,created_at) VALUES('mail','owner','box','inbound','sender@example.test','owner@example.test','received','Hello','<p>Hello</p>','mail.eml',1);`);
 const serialized=JSON.stringify({version:1,replyTo:'reply@example.test',unsubscribeUrl:'https://example.test/unsubscribe'});
 let storageReads=0;const raw=new TextEncoder().encode('Reply-To: reply@example.test\r\nList-Unsubscribe: <https://example.test/unsubscribe>\r\n\r\nHello').buffer;
 const env={DB,BUCKET:{get:async()=>{storageReads++;await new Promise(r=>setTimeout(r,delay));return {arrayBuffer:async()=>raw};}}};
 const rows=[];
 for(let run=0;run<rounds;run++)for(const variant of run%2?['stored','legacy']:['legacy','stored']){
  DB.db.prepare('UPDATE messages SET header_metadata=? WHERE id=?').run(variant==='stored'?serialized:null,'mail');storageReads=0;
  const start=performance.now();const response=await app.getMessageWithBodyForUser(env,{id:'owner',role:'user'},'mail');
  if(response.message.replyTo!=='reply@example.test'||response.unsubscribeUrl!=='https://example.test/unsubscribe')throw Error('Metadata regression');
  rows.push({run,variant,ms:performance.now()-start,storageReads});
 }
 const summary=['legacy','stored'].map(variant=>{const samples=rows.filter(r=>r.variant===variant),times=samples.map(r=>r.ms).sort((a,b)=>a-b);return {variant,p50:times[2],p95:times[4],storageReads:samples.reduce((n,r)=>n+r.storageReads,0)};});
 const result={method:'Local SQLite plus injected original-storage delay; demonstrates dependency removal, not production latency',delayMs:delay,rounds,summary,rows};
 if(process.env.READ_BENCH_OUTPUT)writeFileSync(process.env.READ_BENCH_OUTPUT,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{DB?.db.close();rmSync(dir,{recursive:true,force:true});}
