import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=mkdtempSync(join(process.cwd(),'node_modules','worker-memory-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {getMessageThreadForUser,ThreadBodyLimitError} from './src/lib/email/thread-view';export {getMessageWithBodyForUser} from './src/lib/email/inbound';export {copyMessageAttachments,storeMessageAttachments,validateAttachments} from './src/lib/email/attachments';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1);`);
 const put=[],queries=[],user={id:'owner',role:'user',email:'owner@example.test'};
 const BUCKET={put:async(key,body,options)=>{put.push({key,body,options});},get:async()=>null,delete:async()=>{}};
 const add=(id,{thread='long-thread',status='received',html='<p>Private body</p>',text='Private text'}={})=>DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,text_body,html_body,raw_r2_key,thread_id,created_at) VALUES (?,'owner','box','inbound',?,'owner@example.test',?,?,?,?,?,?,1)`).run(id,id+'@example.test','Subject '+id,status,text,html,'inbound/'+id+'.eml',thread);
 const prepare=DB.prepare.bind(DB);DB.prepare=sql=>{queries.push(sql);const s=prepare(sql),bind=s.bind.bind(s);s.bind=(...values)=>{assert(values.length<=100,'D1 parameter limit must hold even on large conversations');return bind(...values);};return s;};
 return {DB,env:{DB,BUCKET},user,add,queries,put};
}
test('200 large messages return headers only, retain order/attachments and never fetch body columns from D1',async t=>{
 const f=await fixture(t),body='<p>'+('Large email '.repeat(18000))+'</p>';
 for(let i=0;i<200;i++){const id='mail-'+String(i).padStart(3,'0');f.add(id,{html:body});f.DB.db.prepare(`INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES (?,?,?,'application/pdf',42,?,1)`).run('att-'+i,id,'receipt.pdf','attachments/'+i);}
 f.add('hidden-draft',{status:'draft'});f.add('hidden-trash',{status:'trash'});
 const result=await app.getMessageThreadForUser(f.env,f.user,'mail-000');assert.equal(result.messages.length,200);assert(result.messages.every(m=>m.bodyLoaded===false&&m.htmlBody===null&&m.textBody===null));assert.equal(result.messages.at(-1).attachments[0].filename,'receipt.pdf');assert(!JSON.stringify(result).includes('inbound/'));
 assert(Buffer.byteLength(JSON.stringify(result))<400000,'header result stays small regardless of combined body size');assert(f.queries.filter(q=>/select/i.test(q)&&/from "messages"/.test(q)).every(q=>!q.includes('"html_body"')&&!q.includes('"text_body"')),'SQL must omit the actual body columns, rather than deleting them after loading');
});
test('detail responses serialize HTML/text once and keep storage pointers private',async t=>{
 const f=await fixture(t);f.add('mail');const data=await app.getMessageWithBodyForUser(f.env,f.user,'mail');assert.equal(data.body.htmlBody,'<p>Private body</p>');assert.equal(data.body.textBody,'Private text');assert(!('htmlBody' in data.message));assert(!('textBody' in data.message));assert(!JSON.stringify(data).includes('inbound/mail.eml'));assert.equal((JSON.stringify(data).match(/Private body/g)??[]).length,1);
});
test('lightweight threads and single bodies preserve ownership and disabled-mailbox checks',async t=>{
 const f=await fixture(t);f.add('mail');const other={id:'other',role:'user'};assert.equal(await app.getMessageThreadForUser(f.env,other,'mail'),null);assert.equal(await app.getMessageWithBodyForUser(f.env,other,'mail'),null);f.DB.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='box'");assert.equal(await app.getMessageThreadForUser(f.env,f.user,'mail'),null);assert.equal(await app.getMessageWithBodyForUser(f.env,f.user,'mail'),null);
});
test('draft upload stores File objects directly and validates byte/count limits before R2 writes',async t=>{
 const f=await fixture(t);f.add('draft',{status:'draft'});const file=new File(['%PDF-exact-bytes'],'receipt.pdf',{type:'application/pdf'});file.arrayBuffer=()=>{throw Error('extra file copy is forbidden');};
 const stored=await app.storeMessageAttachments(f.env,'draft',[{filename:file.name,type:file.type,content:file}]);assert.equal(f.put[0].body,file);assert.equal(stored[0].size,file.size);assert.equal(f.DB.db.prepare('SELECT size FROM message_attachments').get().size,file.size);
 await assert.rejects(()=>app.storeMessageAttachments(f.env,'draft',[{filename:'huge.pdf',type:'application/pdf',content:new Blob([new Uint8Array(25_000_001)])}]),/25 MB/);assert.equal(f.put.length,1);
});
test('forwarding streams R2 bytes without buffering and preserves an independent attachment object',async t=>{
 const f=await fixture(t);f.add('original');f.add('forward',{status:'draft'});f.DB.db.exec("INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES ('attachment','original','receipt.pdf','application/pdf',5,'original-key',1)");
 const body=new Blob(['bytes']).stream();f.env.BUCKET.get=async()=>({body,arrayBuffer:()=>{throw Error('full attachment buffering is forbidden');}});const copied=await app.copyMessageAttachments(f.env,'original','forward');assert.equal(f.put[0].body,body);assert.equal(await new Response(f.put[0].body).text(),'bytes');assert.equal(copied.length,1);assert.equal(copied[0].size,5);assert.notEqual(f.put[0].key,'original-key');
});

test('legacy cached browsers retain small complete threads but oversized legacy payloads fail before body allocation',async t=>{
 const f=await fixture(t);f.add('small');let result=await app.getMessageThreadForUser(f.env,f.user,'small',true);assert.equal(result.messages[0].htmlBody,'<p>Private body</p>');assert.equal(result.messages[0].bodyLoaded,true);
 f.add('large',{html:'x'.repeat(5*1024*1024)});f.queries.length=0;await assert.rejects(()=>app.getMessageThreadForUser(f.env,f.user,'large',true),app.ThreadBodyLimitError);assert(!f.queries.some(q=>q.startsWith('select "id", "text_body", "html_body"')),'legacy size is checked inside D1 before fetching full body columns');result=await app.getMessageThreadForUser(f.env,f.user,'large');assert.equal(result.messages.length,2);assert(result.messages.every(m=>m.bodyLoaded===false));
});
