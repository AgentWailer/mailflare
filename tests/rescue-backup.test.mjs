import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateKeyPairSync,privateDecrypt,createDecipheriv,createCipheriv,pbkdf2Sync,constants,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';

const dir=mkdtempSync(join(process.cwd(),'node_modules','rescue-backup-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined}}');
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createBackupRecord,listBackups,deleteBackup} from './src/lib/backups/service';export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export';export {processDatabaseBackup,deleteExpiredBackups} from './src/lib/backups/runner';export {createSession} from './src/lib/auth/session';export {POST as setupKey} from './src/app/api/backups/key/route';export {GET as getBackups} from './src/app/api/backups/route';export {encryptRescuePacket,validateRescuePublicKey} from './src/lib/backups/rescue-crypto';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts','next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const keys=generateKeyPairSync('rsa',{modulusLength:3072}),pub=keys.publicKey.export({format:'jwk'});
const publicKey={kty:'RSA',n:pub.n,e:pub.e};
const sha=value=>createHash('sha256').update(value).digest('hex');
export function decryptPacket(value){const data=Buffer.from(value);assert.equal(data.subarray(0,4).toString(),'MFR1');const wrappedLength=data.readUInt16BE(4),end=6+wrappedLength,nonce=data.subarray(end,end+12),header=data.subarray(0,end+12),aes=privateDecrypt({key:keys.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},data.subarray(6,end)),decipher=createDecipheriv('aes-256-gcm',aes,nonce);decipher.setAAD(header);decipher.setAuthTag(data.subarray(-16));return Buffer.concat([decipher.update(data.subarray(end+12,-16)),decipher.final()]);}

function bucket(){
 const objects=new Map(),uploads=new Map(),puts=[],deletes=[];let failCompletion=false,id=0;
 const entry=(key,value,options={})=>({key,bytes:Buffer.from(value),etag:sha(value),size:value.length,httpMetadata:options.httpMetadata??{},customMetadata:options.customMetadata??{}});
 const view=(object,range)=>{const bytes=range?object.bytes.subarray(range.offset,range.offset+range.length):object.bytes;return {...object,body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),arrayBuffer:async()=>Uint8Array.from(bytes).buffer,text:async()=>bytes.toString()};};
 const api={objects,puts,deletes,
  get:async(key,options={})=>{const object=objects.get(key);if(!object)return null;if(options.onlyIf?.etagMatches&&object.etag!==options.onlyIf.etagMatches)return {...object};return view(object,options.range);},
  head:async key=>objects.has(key)?{...objects.get(key)}:null,
  put:async(key,value,options={})=>{const object=entry(key,Buffer.from(value),options);objects.set(key,object);puts.push(key);return {...object};},
  delete:async keys=>{for(const key of Array.isArray(keys)?keys:[keys]){deletes.push(key);objects.delete(key);}},
  list:async({prefix='',cursor='',limit=1000}={})=>{const keys=[...objects.keys()].sort().filter(key=>key.startsWith(prefix)&&key>cursor);return {objects:keys.slice(0,limit).map(key=>({...objects.get(key)})),truncated:keys.length>limit,cursor:keys.length>limit?keys[limit-1]:undefined};},
  createMultipartUpload:async(key,options={})=>{const uploadId='upload-'+(++id);uploads.set(uploadId,{parts:new Map(),options});return api.resumeMultipartUpload(key,uploadId);},
  resumeMultipartUpload:(key,uploadId)=>({uploadId,uploadPart:async(number,bytes)=>{uploads.get(uploadId).parts.set(number,Buffer.from(bytes));return {partNumber:number,etag:sha(bytes)};},complete:async parts=>{const upload=uploads.get(uploadId),buffers=parts.map(part=>upload.parts.get(part.partNumber));for(const part of buffers.slice(0,-1))assert(part.length>=5*1024*1024);const object=entry(key,Buffer.concat(buffers),upload.options);objects.set(key,object);puts.push(key);if(failCompletion){failCompletion=false;throw Error('lost completion response');}return {...object};},abort:async()=>uploads.delete(uploadId)}),
  loseCompletion:()=>failCompletion=true,
 };return api;
}

async function fixture(t,{configured=true}={}){
 const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));t.after(()=>DB.db.close());
 DB.db.exec("INSERT INTO users(id,email,password_hash,name,role,is_primary_admin,created_at) VALUES('owner','owner@example.test','hash','Owner','admin',1,1),('other','other@example.test','hash','Other','admin',0,1);INSERT INTO domains(id,user_id,hostname,zone_id,created_at) VALUES('domain','owner','example.test','manual',1);INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('box','owner','domain','owner',1)");
 if(configured)DB.db.prepare("UPDATE backup_settings SET rescue_public_key=?,enabled=1").run(JSON.stringify(publicKey));
 const source=bucket(),target=bucket(),queue=[],env={DB,BUCKET:source,RESCUE_BUCKET:target,AGENT_QUEUE:{send:async value=>queue.push(value)},MAILFLARE_RUNTIME:'node'};
 const row=id=>DB.db.prepare('SELECT * FROM backups WHERE id=?').get(id);
 const step=async id=>{DB.db.prepare('UPDATE backups SET lease_until=0 WHERE id=?').run(id);await app.processDatabaseBackup(env,id);};
 const drain=async id=>{for(let i=0;i<700&&row(id).status!=='completed';i++){await step(id);assert.notEqual(row(id).status,'failed',row(id).error);}assert.equal(row(id).status,'completed');return JSON.parse(target.objects.get('rescue/current.json').bytes);};
 const readChunk=chunk=>{const data=target.objects.get(chunk.key).bytes;assert.equal(sha(data),chunk.sha256);return JSON.parse(gunzipSync(decryptPacket(data)));};
 const manifest=()=>{const pointer=JSON.parse(target.objects.get('rescue/current.json').bytes);return readChunk(pointer.manifest);};
 const insert=DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,raw_r2_key,status,created_at) VALUES(?,'owner','box','inbound','sender@example.test','owner@example.test','Private invoice',?,?,'received',1)");
 return {DB,source,target,env,queue,row,step,drain,manifest,readChunk,insert};
}

test('public-only encryption rejects private keys and tampering; no server private key is required',async()=>{
 assert.throws(()=>app.validateRescuePublicKey({...publicKey,d:'private-material'}));assert.throws(()=>app.validateRescuePublicKey({kty:'RSA',n:'short',e:'AQAB'}));
 const packet=await app.encryptRescuePacket(publicKey,Buffer.from('private fixture'));assert.equal(decryptPacket(packet).toString(),'private fixture');packet[packet.length-20]^=1;assert.throws(()=>decryptPacket(packet));
});

test('pre-migration database backups remain restorable and operational rescue indexes stay excluded',async t=>{
 const migrations=join(dir,'old-migrations');cpSync(join(process.cwd(),'drizzle/migrations'),migrations,{recursive:true});rmSync(join(migrations,'0079_single_rescue_snapshot.sql'));
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,migrations);DB.db.exec("INSERT INTO users(id,email,password_hash,name,created_at) VALUES('legacy','legacy@example.test','hash','Legacy',1);INSERT INTO backups(id,status,trigger,created_at) VALUES('legacy-backup','completed','manual',1)");
 const bytes=await app.exportDatabaseRecords(DB);await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));assert.equal(DB.db.prepare('SELECT enabled FROM backup_settings').get().enabled,0);await app.restoreDatabaseRecords(DB,Uint8Array.from(bytes).buffer);assert.equal(DB.db.prepare("SELECT name FROM users WHERE id='legacy'").get().name,'Legacy');assert.equal(DB.db.prepare("SELECT kind FROM backups WHERE id='legacy-backup'").get().kind,'database');assert.equal(DB.db.prepare('SELECT rescue_public_key FROM backup_settings').get().rescue_public_key,null);
 const after=JSON.parse(Buffer.from(await app.exportDatabaseRecords(DB)));assert(!('backup_snapshot_objects'in after.tables));assert(!('backup_snapshot_links'in after.tables));
});

test('one encrypted rescue point round-trips the database, empty files and multipart objects',async t=>{
 const f=await fixture(t),secret='Confidential invoice Grüße 🌍';await f.source.put('inbound/mail.eml',Buffer.from(secret));await f.source.put('attachments/file',Buffer.from('%PDF fixture'));await f.source.put('empty',Buffer.alloc(0));await f.source.put('drive/large',Buffer.alloc(8*1024*1024+500,37));
 f.DB.db.exec("INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('parent','owner','box','Parent',1);INSERT INTO folders(rowid,id,user_id,mailbox_id,name,parent_id,created_at) VALUES(-1,'child','owner','box','Child','parent',1)");
 f.insert.run('mail',secret,'inbound/mail.eml');f.DB.db.exec("INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES('attachment','mail','invoice.pdf','application/pdf',12,'attachments/file',1)");
 f.insert.run('large-body','Large mail '.repeat(20000),null);
 const id=await app.createBackupRecord(f.env,'manual','owner');const duplicate=await app.createBackupRecord(f.env,'manual','owner');assert.equal(duplicate,id,'only one rescue build may run');await f.drain(id);const doc=f.manifest();assert.equal(doc.objects.count,4);assert.equal(doc.scope,'database-and-live-objects');
 const messages=doc.database.parts.map(f.readChunk).filter(chunk=>chunk.table==='messages').flatMap(chunk=>chunk.records);assert.equal(messages[0].text_body,secret);assert(!doc.database.tables.includes('backup_snapshot_objects'));assert(!doc.database.tables.includes('backup_snapshot_links'));
 const entries=doc.objects.shards.flatMap(f.readChunk);for(const item of entries){const encrypted=f.target.objects.get(item.blobKey).bytes,parts=[];for(let i=0,offset=0;i<item.checksums.length;i++){const length=Math.min(8*1024*1024,item.size-i*8*1024*1024)+418,packet=encrypted.subarray(offset,offset+length);assert.equal(sha(packet),item.checksums[i]);parts.push(decryptPacket(packet));offset+=length;}assert.deepEqual(Buffer.concat(parts),f.source.objects.get(item.key).bytes);}
 for(const [key,object]of f.target.objects){if(key!=='rescue/current.json'){assert(!object.bytes.includes(Buffer.from(secret)));assert(!object.bytes.includes(Buffer.from('owner@example.test')));}}
 assert(f.row(id).verified_at);await assert.rejects(()=>app.deleteBackup(f.env,id));assert.equal(await app.deleteExpiredBackups(f.env),0);
 const out=join(dir,'roundtrip');mkdirSync(out);for(const [key,value]of f.target.objects){const path=join(out,key);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,value.bytes);}
 const salt=Buffer.alloc(16,3),iv=Buffer.alloc(12,4),derived=pbkdf2Sync('fixture recovery password',salt,600000,32,'sha256'),cipher=createCipheriv('aes-256-gcm',derived,iv);const encrypted=Buffer.concat([cipher.update(keys.privateKey.export({type:'pkcs8',format:'der'})),cipher.final(),cipher.getAuthTag()]);
 const keyFile=join(out,'private.json');writeFileSync(keyFile,JSON.stringify({format:'mailflare-rescue-private-key',version:1,publicKey,kdf:{algorithm:'PBKDF2-SHA256',iterations:600000,salt:salt.toString('base64')},cipher:{algorithm:'AES-256-GCM',iv:iv.toString('base64')},encryptedPrivateKey:encrypted.toString('base64')}));
 const recovered=join(dir,'recovered');const result=execFileSync('python3',['-c',`import importlib.util,json\nspec=importlib.util.spec_from_file_location('recovery','scripts/recover-rescue.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nkey,fingerprint=module.load_private_key(${JSON.stringify(keyFile)},'fixture recovery password')\nprint(json.dumps(module.recover(module.Store(directory=${JSON.stringify(out)}),key,fingerprint,${JSON.stringify(recovered)})))`],{encoding:'utf8'});assert.equal(JSON.parse(result).objects,4);
 const restored=new app.SqliteDatabase(join(recovered,'mailflare.sqlite'));assert.equal(restored.db.prepare("SELECT text_body FROM messages WHERE id='mail'").get().text_body,secret);assert.equal(restored.db.prepare('SELECT enabled FROM backup_settings').get().enabled,0);assert.equal(restored.db.prepare('SELECT count(*) AS n FROM backup_snapshot_objects').get().n,4);restored.db.close();
 const imported=execFileSync('python3',['-c',`import importlib.util,json,sqlite3\nspec=importlib.util.spec_from_file_location('restore','scripts/restore-rescue-to-cloudflare.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nclass Target:\n def __init__(self):\n  self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row;self.db.execute('PRAGMA foreign_keys=ON')\n def query(self,sql,params=()):\n  assert len(sql)<100000\n  cursor=self.db.execute(sql,params);self.db.commit();return [dict(row) for row in cursor.fetchall()] if cursor.description else []\nclass Objects:\n def __init__(self): self.count=0\n def empty(self): return True\n def put(self,entry,path):\n  assert path.stat().st_size==entry['size'];self.count+=1\ntarget=Target();objects=Objects();result=module.restore(${JSON.stringify(recovered)},target,objects)\nassert target.db.execute("SELECT parent_id FROM folders WHERE id='child'").fetchone()[0]=='parent'\nassert target.db.execute("SELECT text_body FROM messages WHERE id='mail'").fetchone()[0]==${JSON.stringify(secret)}\nassert target.db.execute('SELECT count(*) FROM messages_fts').fetchone()[0]==2\nprint(json.dumps(result))`],{encoding:'utf8'});assert.equal(JSON.parse(imported).objects,4);
});

test('replacements reuse unchanged ciphertext and remove old generations only after commit',async t=>{
 const f=await fixture(t);await f.source.put('keep',Buffer.from('unchanged'));await f.source.put('remove',Buffer.from('old'));f.DB.db.exec("INSERT INTO backups(id,status,trigger,r2_key,created_at) VALUES('legacy','completed','manual','backups/database/legacy/old.json',1)");await f.source.put('backups/database/legacy/old.json',Buffer.from('legacy'));
 const first=await app.createBackupRecord(f.env,'manual','owner');await f.drain(first);assert(!f.source.objects.has('backups/database/legacy/old.json'));const old=f.manifest(),entries=old.objects.shards.flatMap(f.readChunk),kept=entries.find(entry=>entry.key==='keep'),removed=entries.find(entry=>entry.key==='remove');const puts=f.target.puts.filter(key=>key===kept.blobKey).length;
 await f.source.delete('remove');await f.source.put('new',Buffer.from('new'));const second=await app.createBackupRecord(f.env,'manual','owner');await f.step(second);assert.equal(JSON.parse(f.target.objects.get('rescue/current.json').bytes).backupId,first);assert(f.target.objects.has(removed.blobKey));await f.drain(second);
 assert.equal(f.target.puts.filter(key=>key===kept.blobKey).length,puts);assert(f.target.objects.has(kept.blobKey));assert(!f.target.objects.has(removed.blobKey));assert.equal(f.DB.db.prepare('SELECT count(*) AS n FROM backups').get().n,1);assert(![...f.target.objects.keys()].some(key=>key.startsWith(`rescue/snapshots/${first}/`)));
});

test('failed verification retains the previous verified rescue point',async t=>{
 const f=await fixture(t);await f.source.put('file',Buffer.from('important'));const first=await app.createBackupRecord(f.env,'manual','owner');await f.drain(first);const pointer=Buffer.from(f.target.objects.get('rescue/current.json').bytes);
 const second=await app.createBackupRecord(f.env,'manual','owner');for(let i=0;i<400;i++){await f.step(second);const state=JSON.parse(f.row(second).checkpoint);if(state.phase==='publish'){f.target.objects.get(state.parts[0].key).bytes[10]^=1;break;}}
 for(let i=0;i<5;i++)await f.step(second);assert.equal(f.row(second).status,'failed');assert.deepEqual(f.target.objects.get('rescue/current.json').bytes,pointer);assert.equal(f.row(first).status,'completed');
});

test('cleanup never removes the old copy when the published pointer disappears',async t=>{
 const f=await fixture(t);await f.source.put('file',Buffer.from('important'));const first=await app.createBackupRecord(f.env,'manual','owner');await f.drain(first);const second=await app.createBackupRecord(f.env,'manual','owner');
 for(let i=0;i<400;i++){await f.step(second);const state=JSON.parse(f.row(second).checkpoint);if(state.phase==='cleanup')break;}
 const pointer=Buffer.from(f.target.objects.get('rescue/current.json').bytes);await f.target.delete('rescue/current.json');await f.step(second);assert.equal(f.row(first).status,'completed');assert.equal(f.row(second).status,'running');assert(f.row(second).lease_until>Date.now());await f.target.put('rescue/current.json',pointer);await f.drain(second);
});

test('a missing rescue binding cannot fall back to an unencrypted Cloudflare export',async t=>{
 const f=await fixture(t,{configured:false});const env={...f.env,MAILFLARE_RUNTIME:undefined,RESCUE_BUCKET:undefined};await assert.rejects(()=>app.createBackupRecord(env,'manual','owner'));assert.equal(f.source.puts.length,0);assert.equal(f.DB.db.prepare('SELECT count(*) AS n FROM backups').get().n,0);
});

test('a missing required source file and changed parent reference cannot publish an incomplete rescue point',async t=>{
 const f=await fixture(t);f.insert.run('mail','Content','missing.eml');const id=await app.createBackupRecord(f.env,'manual','owner');for(let i=0;i<120&&f.row(id).status!=='failed';i++)await f.step(id);assert.equal(f.row(id).status,'failed');assert(!f.target.objects.has('rescue/current.json'));
});

test('concurrent changes cannot publish a database snapshot with dangling foreign keys',async t=>{
 const f=await fixture(t);f.DB.db.exec("INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('existing','owner','box','Existing',1)");f.insert.run('mail','Content',null);const id=await app.createBackupRecord(f.env,'manual','owner');await f.step(id);f.DB.db.exec("INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('new-parent','owner','box','New',1);UPDATE messages SET folder_id='new-parent' WHERE id='mail'");for(let i=0;i<120&&f.row(id).status!=='failed';i++)await f.step(id);assert.equal(f.row(id).status,'failed');assert(!f.target.objects.has('rescue/current.json'));
});

test('an interrupted multipart completion resumes from the durable copy checkpoint',async t=>{
 const f=await fixture(t);await f.source.put('large',Buffer.alloc(8*1024*1024+100,17));f.target.loseCompletion();const id=await app.createBackupRecord(f.env,'manual','owner');await f.drain(id);assert.equal(f.manifest().objects.count,1);
});

test('only the primary admin may install a public key; private material is never accepted',async t=>{
 const f=await fixture(t,{configured:false});globalThis.__mailflareNodeEnv=f.env;await assert.rejects(()=>app.createBackupRecord(f.env,'manual','owner'));assert.equal(f.DB.db.prepare('SELECT count(*) AS n FROM backups').get().n,0);
 const owner=await app.createSession(f.env,'owner'),other=await app.createSession(f.env,'other');
 const request=(token,key)=>new Request('https://mailflare.test/api/backups/key',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({publicKey:key})});
 assert.equal((await app.setupKey(request(other,publicKey))).status,403);assert.equal((await app.setupKey(request(owner,{...publicKey,d:'never-store-this'}))).status,400);assert.equal((await app.setupKey(request(owner,publicKey))).status,200);
 const data=f.DB.db.prepare('SELECT rescue_public_key,enabled,schedule_type,retention_enabled FROM backup_settings').get();assert.deepEqual(JSON.parse(data.rescue_public_key),publicKey);assert.equal(data.enabled,1);assert.equal(data.schedule_type,'weekly');assert.equal(data.retention_enabled,0);assert.equal((await app.setupKey(request(owner,publicKey))).status,409);
});

test('the encryption packet runs in the actual Cloudflare Workers runtime',async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');const worker=await build({stdin:{contents:`import {validateRescuePublicKey} from './src/lib/backups/rescue-crypto';import{putVerifiedChunk}from'./src/lib/backups/rescue-storage';export default {async fetch(request,env){const data=await request.json();const chunk=await putVerifiedChunk(env.BACKUP,'fixture',new TextEncoder().encode(data.text),validateRescuePublicKey(data.publicKey));return new Response((await env.BACKUP.get(chunk.key)).body)}};`,resolveDir:process.cwd()},write:false,bundle:true,platform:'browser',format:'esm',external:['node:*'],logLevel:'silent'});
 const options={name:'crypto-fixture',r2Buckets:['BACKUP'],modules:true,script:worker.outputFiles[0].text,compatibilityDate:'2026-05-20',compatibilityFlags:['nodejs_compat']};const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);try{const response=await mf.dispatchFetch('http://fixture.test',{method:'POST',body:JSON.stringify({publicKey,text:'Worker encryption fixture'})});assert.equal(response.status,200,await response.clone().text());assert.equal(gunzipSync(decryptPacket(new Uint8Array(await response.arrayBuffer()))).toString(),'Worker encryption fixture');}finally{await mf.dispose();}
});
