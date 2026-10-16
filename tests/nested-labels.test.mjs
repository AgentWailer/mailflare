import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-nested-labels-'));
after(() => rmSync(dir, {recursive:true, force:true}));
writeFileSync(join(dir,'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
 export {applyMigrations} from './server/runtime/migrate.ts';
 export {createSession} from './src/lib/auth/session.ts';
 export {GET,PATCH} from './src/app/api/settings/labels/route.ts';
 export {POST as createLabel} from './src/app/api/folders/route.ts';
 export {PATCH as moveLabel,DELETE as deleteLabel} from './src/app/api/folders/[folderId]/route.ts';
 export {getLabelPath,visibleLabelGroups} from './src/lib/folders/hierarchy.ts';
 export {GET as listLabels} from './src/app/api/folders/route.ts';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';
`, resolveDir:process.cwd()}, outfile:join(dir,'app.mjs'), bundle:true, platform:'node', format:'esm', packages:'external', tsconfig:'tsconfig.json', alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'}, logLevel:'silent'});
const app = await import(pathToFileURL(join(dir,'app.mjs')).href);

const oldMigrations=join(dir,"old-migrations");mkdirSync(oldMigrations);for(const name of readdirSync("drizzle/migrations").filter(name=>name.endsWith(".sql")&&name<"0064"))copyFileSync(join("drizzle/migrations",name),join(oldMigrations,name));

async function fixture(t, beforeMigration=false) {
 const DB = new app.SqliteDatabase(':memory:');
 await app.applyMigrations(DB, beforeMigration ? oldMigrations : join(process.cwd(),'drizzle/migrations'));
 t.after(() => {DB.db.close(); delete globalThis.__mailflareNodeEnv;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES
 ('owner','owner@example.test','hash','Owner','user',1),('delegate','delegate@example.test','hash','Delegate','user',1),('foreign','foreign@example.test','hash','Foreign','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('other','foreign','domain','foreign','personal',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('work','owner','box','Work',1),('family','owner','box','Family',1),('secret','foreign','other','Secret',1);
 INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('access','box','delegate','read_only',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at,folder_id) VALUES ('message','owner','box','inbound','sender@example.test','owner@example.test','received',1,'work');
 INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES ('message','work');`);
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['owner','delegate','foreign']) tokens[id]=await app.createSession(env,id);
 const request=(actor='owner',body,mailbox='box')=>new Request('https://mailflare.test/api/settings/labels?mailboxId='+mailbox,{method:body===undefined?'GET':'PATCH',headers:{...(tokens[actor]?{Authorization:'Bearer '+tokens[actor]}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const patch=(labelId,visible=false,actor='owner',mailboxId='box')=>app.PATCH(request(actor,{mailboxId,labelId,visible}));
 const hidden=async(actor='owner',mailbox='box')=>{const response=await app.GET(request(actor,undefined,mailbox));assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');return (await response.json()).hiddenLabelIds;};
 return {DB,env,request,patch,hidden};
}


function apiRequest(f, body, method='POST', actor='owner', mailbox='box') {
 const auth=f.request(actor).headers.get('Authorization');
 return new Request('https://mailflare.test/api/folders?mailboxId='+mailbox,{method,headers:{...(auth?{Authorization:auth}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
const context=id=>({params:Promise.resolve({folderId:id})});
const move=(f,id,parentId,actor='owner',mailboxId='box')=>app.moveLabel(apiRequest(f,{mailboxId,parentId},'PATCH',actor),context(id));

test('existing labels stay at the top; creating and moving sublabels preserves mail and labels',async t=>{
 const f=await fixture(t);const created=await app.createLabel(apiRequest(f,{mailboxId:'box',name:'Receipts',parentId:'work'}));
 assert.equal(created.status,200);const child=await created.json();assert.equal(child.parentId,'work');
 assert.equal((await move(f,'family',child.id)).status,200);
 const rows=(await(await app.listLabels(f.request())).json()).folders;
 assert.equal(rows.find(x=>x.id==='work').parentId,null);assert.equal(rows.find(x=>x.id==='family').parentId,child.id);
 assert.equal(app.getLabelPath(rows.find(x=>x.id==='family'),rows),'Work / Receipts / Family');
 assert.equal(f.DB.db.prepare("SELECT folder_id FROM messages WHERE id='message'").get().folder_id,'work');
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
 assert.equal((await move(f,'family',null)).status,200);
});

test('authentication, mailbox access and invalid parents cannot alter hierarchy',async t=>{
 const f=await fixture(t);f.DB.db.exec("UPDATE mailboxes SET type='shared' WHERE id='box'");
 for(const actor of ['delegate','foreign']) {assert.equal((await move(f,'work','family',actor)).status,404);assert.equal((await app.createLabel(apiRequest(f,{mailboxId:'box',name:'Denied',parentId:'work'},'POST',actor))).status,404);}
 assert.equal((await move(f,'work','family','unauthenticated')).status,401);
 for(const parentId of ['missing','secret']) {assert.equal((await move(f,'work',parentId)).status,404);assert.equal((await app.createLabel(apiRequest(f,{mailboxId:'box',name:'Invalid',parentId}))).status,404);}
 for(const parentId of ['work',42])assert.equal((await move(f,'work',parentId)).status,400);
 const malformed=new Request('https://mailflare.test/api/folders',{method:'PATCH',headers:f.request().headers,body:'{'});assert.equal((await app.moveLabel(malformed,context('work'))).status,400);
 assert.equal(f.DB.db.prepare("SELECT parent_id FROM folders WHERE id='work'").get().parent_id,null);
});

test('atomic database validation prevents deep cycles and racing reciprocal moves',async t=>{
 const f=await fixture(t);assert.equal((await move(f,'family','work')).status,200);
 assert.equal((await move(f,'work','family')).status,400);
 await move(f,'family',null);
 const result=await Promise.all([move(f,'family','work'),move(f,'work','family')]);assert.deepEqual(result.map(r=>r.status).sort(),[200,400]);
 assert.throws(()=>f.DB.db.exec("UPDATE folders SET parent_id='secret' WHERE id='work'"),/Invalid label parent/);
});

test('deleting a parent keeps children, nested descendants and their messages',async t=>{
 const f=await fixture(t);await move(f,'family','work');
 f.DB.db.exec("UPDATE messages SET folder_id='family' WHERE id='message'; INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES ('message','family'); INSERT INTO folders(id,user_id,mailbox_id,name,parent_id,created_at) VALUES ('grandchild','owner','box','Grandchild','family',1)");
 const deleted=await app.deleteLabel(apiRequest(f,undefined,'DELETE'),context('work'));assert.equal(deleted.status,200);
 assert.equal(f.DB.db.prepare("SELECT parent_id FROM folders WHERE id='family'").get().parent_id,null);
 assert.equal(f.DB.db.prepare("SELECT parent_id FROM folders WHERE id='grandchild'").get().parent_id,'family');
 assert.equal(f.DB.db.prepare("SELECT folder_id FROM messages WHERE id='message'").get().folder_id,'family');
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
});

test('unordered backups restore nested labels; older backups retain flat labels',async t=>{
 const f=await fixture(t);await move(f,'family','work');
 const backup=JSON.parse(new TextDecoder().decode(await app.exportDatabaseRecords(f.DB)));
 backup.tables.folders.reverse();await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(backup)).buffer);
 assert.equal(f.DB.db.prepare("SELECT parent_id FROM folders WHERE id='family'").get().parent_id,'work');
 for(const row of backup.tables.folders)delete row.parent_id;
 await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(backup)).buffer);
 assert.equal(f.DB.db.prepare("SELECT parent_id FROM folders WHERE id='family'").get().parent_id,null);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
});

test('hidden parents keep visible children accessible; malformed imported hierarchy is cycle-safe',()=>{
 const labels=[{id:'parent',name:'Projects'},{id:'child',name:'Client',parentId:'parent'},{id:'orphan',name:'Notes',parentId:'missing'}];
 const groups=app.visibleLabelGroups(labels,['parent']);assert.deepEqual(groups.get(null).map(x=>x.id),['child','orphan']);
 assert.equal(app.getLabelPath(labels[1],labels),'Projects / Client');
 const cycle=[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}];assert.equal(app.visibleLabelGroups(cycle,[]).get(null).length,2);assert.equal(app.getLabelPath(cycle[0],cycle),'B / A');
});

test('backups work before the migration; nested backups require migration before deleting existing data',async t=>{
 const current=await fixture(t);await move(current,'family','work');const nestedBackup=await app.exportDatabaseRecords(current.DB);
 const old=await fixture(t,true);const oldBackup=await app.exportDatabaseRecords(old.DB);await app.restoreDatabaseRecords(old.DB,oldBackup.buffer);
 assert.equal(old.DB.db.prepare('SELECT count(*) n FROM folders').get().n,3);
 await assert.rejects(app.restoreDatabaseRecords(old.DB,nestedBackup.buffer),/Apply pending database migrations before restoring nested labels/);
 assert.equal(old.DB.db.prepare('SELECT count(*) n FROM folders').get().n,3);
 assert.equal(old.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);
});

test('renaming keeps message assignments, filter targets, children and ordering IDs unchanged',async t=>{
 const f=await fixture(t);await app.createLabel(apiRequest(f,{mailboxId:'box',name:'Child',parentId:'work'}));
 f.DB.db.exec(`INSERT INTO routing_rules(id,user_id,domain_id,pattern,mailbox_id,folder_id,label_ids,created_at) VALUES('rule','owner','domain','sender@example.test','box','work','["work"]',1);`);
 const ruleBefore=f.DB.db.prepare("SELECT folder_id,label_ids FROM routing_rules WHERE id='rule'").get();
 const before=f.DB.db.prepare('SELECT folder_id,subject,status FROM messages WHERE id=?').get('message');
 const children=f.DB.db.prepare("SELECT id,parent_id FROM folders WHERE parent_id='work'").all();
 const response=await app.moveLabel(apiRequest(f,{mailboxId:'box',name:'  Projects  '},'PATCH'),context('work'));assert.equal(response.status,200);const body=await response.json();assert.equal(body.folder.id,'work');assert.equal(body.folder.name,'Projects');assert.equal(body.folder.parentId,null);
 assert.deepEqual(f.DB.db.prepare('SELECT folder_id,subject,status FROM messages WHERE id=?').get('message'),before);assert.equal(f.DB.db.prepare("SELECT folder_id FROM message_labels WHERE message_id='message'").get().folder_id,'work');assert.deepEqual(f.DB.db.prepare("SELECT id,parent_id FROM folders WHERE parent_id='work'").all(),children);
 const rows=(await(await app.listLabels(f.request())).json()).folders;assert.equal(app.getLabelPath(rows.find(x=>x.id===children[0].id),rows),'Projects / Child');
 assert.deepEqual(f.DB.db.prepare("SELECT folder_id,label_ids FROM routing_rules WHERE id='rule'").get(),ruleBefore);
 const renamedChild=await app.moveLabel(apiRequest(f,{mailboxId:'box',name:'Receipts'},'PATCH'),context(children[0].id));assert.equal(renamedChild.status,200);assert.equal((await renamedChild.json()).folder.parentId,'work');
});

test('rename rejects duplicates, invalid input and foreign or read-only access without changing labels',async t=>{
 const f=await fixture(t);f.DB.db.exec("UPDATE mailboxes SET type='shared' WHERE id='box'");
 for(const name of ['', '  ', 'x'.repeat(81),'bad\u0000name'])assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',name},'PATCH'),context('work'))).status,400);
 assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',name:'Family'},'PATCH'),context('work'))).status,409);
 for(const actor of ['delegate','foreign'])assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',name:'Denied'},'PATCH',actor),context('work'))).status,404);
 assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',name:'Denied'},'PATCH','unauthenticated'),context('work'))).status,401);
 assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',name:'Wrong mailbox'},'PATCH'),context('secret'))).status,404);
 assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box'},'PATCH'),context('work'))).status,400);assert.equal(f.DB.db.prepare("SELECT name FROM folders WHERE id='work'").get().name,'Work');
});


test('recoloring persists safely without changing names, hierarchy or message assignments',async t=>{
 const f=await fixture(t);await move(f,'family','work');
 const before=f.DB.db.prepare("SELECT id,name,parent_id FROM folders WHERE id='family'").get();
 const message=f.DB.db.prepare("SELECT * FROM messages WHERE id='message'").get();
 const result=await app.moveLabel(apiRequest(f,{mailboxId:'box',color:'#DC2626'},'PATCH'),context('family'));
 assert.equal(result.status,200);assert.equal((await result.json()).folder.color,'#dc2626');
 assert.deepEqual(f.DB.db.prepare("SELECT id,name,parent_id FROM folders WHERE id='family'").get(),before);
 assert.deepEqual(f.DB.db.prepare("SELECT * FROM messages WHERE id='message'").get(),message);
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM message_labels").get().n,1);
 for(const color of ['red','#fff','url(https://example.org)',null,42])assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',color},'PATCH'),context('family'))).status,400);
 f.DB.db.exec("UPDATE mailboxes SET type='shared' WHERE id='box'");
 for(const actor of ['delegate','foreign'])assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',color:'#2563eb'},'PATCH',actor),context('family'))).status,404);
 assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',color:'#2563eb'},'PATCH','unauthenticated'),context('family'))).status,401);
 assert.equal((await app.moveLabel(apiRequest(f,{mailboxId:'box',color:'#2563eb'},'PATCH'),context('secret'))).status,404);
 assert.equal(f.DB.db.prepare("SELECT color FROM folders WHERE id='family'").get().color,'#dc2626');
});
