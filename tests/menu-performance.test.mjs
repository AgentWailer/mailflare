import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('',{url:'https://mailflare.test'});
for(const key of ['window','document','localStorage','CustomEvent','Event'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
const dir=mkdtempSync(join(process.cwd(),'node_modules','menu-performance-'));after(()=>{dom.window.close();rmSync(dir,{recursive:true,force:true});});
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {getDb} from './src/db';export {driveItems} from './src/db/schema';export {toDriveItemDtos,withoutTrashedAncestors,getDriveRole} from './src/lib/drive/access';export {fetchMailboxFolders,clearMailboxFoldersCache} from './src/components/messages/use-mailbox-folders';export {setClientSessionToken} from './src/lib/auth/client';export {getDriveCacheRevision,readDriveListing,saveDriveListing,clearDriveListings} from './src/app/(drive)/drive-cache';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
async function fixture(t){const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));const db=app.getDb({DB});const prepare=DB.prepare.bind(DB);DB.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...values)=>{assert(values.length<=100,'respect D1 parameter limit');return bind(...values);};return statement;};return {DB,db};}

test('1,000 Drive rows with 260 owners use two metadata round trips and retain exact names/sharing/privacy',async t=>{
 const {DB,db}=await fixture(t);const user=DB.db.prepare('INSERT INTO users(id,email,password_hash,name,created_at) VALUES(?,?,\'hash\',?,1)');const item=DB.db.prepare("INSERT INTO drive_items(id,owner_id,kind,name,link_token,created_at,updated_at) VALUES(?,?,'file',?,?,1,1)");
 DB.db.transaction(()=>{for(let i=0;i<260;i++)user.run('u'+i,'owner'+i+'@example.test','Owner '+i);for(let i=0;i<1000;i++){item.run('f'+i,'u'+i%260,'File '+i,i%100===0?'token-'+i:null);if(i%10===0)DB.db.prepare("INSERT INTO drive_shares(id,item_id,user_id,role,created_at) VALUES(?,?, 'u0','view',1)").run('share-'+i,'f'+i);}})();
 const rows=await db.select().from(app.driveItems);let batches=0,singles=0;const originalBatch=DB.batch.bind(DB),originalPrepare=DB.prepare.bind(DB);DB.batch=async statements=>{batches++;assert(statements.length<=25);return originalBatch(statements);};DB.prepare=sql=>{singles++;return originalPrepare(sql);};
 const dtos=await app.toDriveItemDtos(db,rows,'u0');assert.equal(dtos.length,1000);assert.equal(batches,2,'one bounded owner batch and one share batch');assert.equal(singles,17,'four owner queries and thirteen share queries');
 for(let i=0;i<1000;i++){const dto=dtos.find(row=>row.id==='f'+i);assert.equal(dto.ownerName,'Owner '+i%260);assert.equal(dto.shared,i%10===0);assert.equal(dto.role,i%260===0?'owner':'view');assert.equal(dto.linkToken,i%260===0&&i%100===0?'token-'+i:null);}
});

test('Drive ancestor resolution loads a whole tree by depth and hides trashed descendants without a request per folder',async t=>{
 const {DB,db}=await fixture(t);DB.db.exec("INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','hash','Owner',1)");const insert=DB.db.prepare("INSERT INTO drive_items(id,owner_id,parent_id,kind,name,trashed_at,created_at,updated_at) VALUES(?,'owner',?,?,?, ?,1,1)");
 DB.db.transaction(()=>{insert.run('root',null,'folder','Root',null);insert.run('trash',null,'folder','Trash',1);for(let i=0;i<200;i++){insert.run('parent-'+i,i%2?'root':'trash','folder','Parent',null);insert.run('child-'+i,'parent-'+i,'file','Child',null);}})();
 const rows=(await db.select().from(app.driveItems)).filter(row=>row.kind==='file');let queries=0;const original=DB.prepare.bind(DB);DB.prepare=sql=>{queries++;assert(!sql.includes('r2_key'),'ancestor lookups need only hierarchy metadata');return original(sql);};
 const kept=await app.withoutTrashedAncestors(db,rows);assert.equal(kept.length,100);assert(kept.every(row=>Number(row.id.split('-')[1])%2===1));assert.equal(queries,4,'three bounded parent pages and one root page');
});

test('simultaneous sidebar and label menus share a request and reuse the recent result',async t=>{
 app.clearMailboxFoldersCache();let count=0,resolve;t.mock.method(globalThis,'fetch',()=>{count++;return new Promise(r=>resolve=r);});
 const a=app.fetchMailboxFolders('box'),b=app.fetchMailboxFolders('box');assert.equal(count,1);resolve(Response.json({folders:[{id:'label',name:'Work',parentId:null}]}));assert.deepEqual(await a,await b);assert.equal((await app.fetchMailboxFolders('box'))[0].name,'Work');assert.equal(count,1);
 window.dispatchEvent(new Event('mailflare:messages-changed'));const fresh=app.fetchMailboxFolders('box');assert.equal(count,2);resolve(Response.json({folders:[]}));assert.deepEqual(await fresh,[]);
});

test('folder responses cannot refill another account cache; failures and invalidations remain retryable',async t=>{
 app.clearMailboxFoldersCache();app.setClientSessionToken('old');const resolve=[];let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise(r=>resolve.push(r));});
 const old=app.fetchMailboxFolders('box');app.setClientSessionToken('new');const next=app.fetchMailboxFolders('box');assert.equal(calls,2);resolve[0](Response.json({folders:[{id:'old'}]}));await old;const joined=app.fetchMailboxFolders('box');assert.equal(calls,2);resolve[1](new Response('',{status:503}));await assert.rejects(next);await assert.rejects(joined);const retry=app.fetchMailboxFolders('box');assert.equal(calls,3);resolve[2](Response.json({folders:[{id:'new',name:'New'}]}));assert.equal((await retry)[0].id,'new');assert.equal((await app.fetchMailboxFolders('box'))[0].id,'new');
});

test('recent folder definitions expire and revalidate instead of persisting stale menu data',async t=>{
 app.clearMailboxFoldersCache();let calls=0;t.mock.method(globalThis,'fetch',async()=>Response.json({folders:[{id:'label',name:'Version '+(++calls)}]}));
 const now=Date.now();t.mock.method(Date,'now',()=>now);assert.equal((await app.fetchMailboxFolders('expiry'))[0].name,'Version 1');assert.equal((await app.fetchMailboxFolders('expiry'))[0].name,'Version 1');
 Date.now=()=>now+31000;assert.equal((await app.fetchMailboxFolders('expiry'))[0].name,'Version 2');assert.equal(calls,2);
});

test('Drive keeps current permissions and hidden ancestors authoritative after sharing changes',async t=>{
 const {DB,db}=await fixture(t);DB.db.exec("INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','hash','Owner',1),('reader','reader@example.test','hash','Reader',1);INSERT INTO drive_items(id,owner_id,parent_id,kind,name,created_at,updated_at) VALUES('root','owner',NULL,'folder','Shared',1,1),('child','owner','root','file','Child',1,1);INSERT INTO drive_shares(id,item_id,user_id,role,created_at) VALUES('grant','root','reader','view',1)");
 const child=(await db.select().from(app.driveItems)).find(row=>row.id==='child');assert.equal(await app.getDriveRole(db,'reader',child),'view');DB.db.exec("DELETE FROM drive_shares WHERE id='grant'");assert.equal(await app.getDriveRole(db,'reader',child),null);DB.db.exec("UPDATE drive_items SET trashed_at=1 WHERE id='root'");assert.deepEqual(await app.withoutTrashedAncestors(db,[child]),[]);assert.equal(await app.getDriveRole(db,'owner',child),null);
});


test('instant Drive folder caches stay account scoped and reject late responses after account changes or invalidation',()=>{
 const value={items:[{id:'private-old-account'}],path:[],role:'owner',storageUsed:1,storageLimit:null};
 app.setClientSessionToken('drive-old');const old=app.getDriveCacheRevision();assert.equal(app.saveDriveListing('my|||',value,old),true);assert.equal(app.readDriveListing('my|||').items[0].id,'private-old-account');
 app.setClientSessionToken('drive-new');assert.equal(app.readDriveListing('my|||'),undefined);assert.equal(app.saveDriveListing('my|||',value,old),false);assert.equal(app.readDriveListing('my|||'),undefined);
 const current=app.getDriveCacheRevision();app.clearDriveListings();assert.equal(app.saveDriveListing('my|||',value,current),false,'an invalidated upload/move cannot be overwritten by an older folder fetch');
});
