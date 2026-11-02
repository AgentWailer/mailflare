import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';

const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','bootstrap-schema-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database'; export {migrateCleanDatabase} from './src/lib/setup/migration'; export {getMigrationStatus} from './src/lib/migrations/service'; export {createDb} from './src/db'; export {mailboxes,licenseSettings} from './src/db/schema';`,resolveDir:root},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));

test('fresh bootstrap applies each bundled migration once and safely resumes without reapplying schema',async t=>{
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());
 assert.equal(await app.migrateCleanDatabase(DB),true);
 const names=DB.db.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map(row=>row.name);
 assert.deepEqual(names,readdirSync(join(root,'drizzle/migrations')).filter(name=>name.endsWith('.sql')).sort());
 assert.deepEqual(await app.getMigrationStatus(DB),{ready:true,pending:[],unknown:[]});
 assert.equal(await app.migrateCleanDatabase(DB),false);
 assert.equal(DB.db.prepare('SELECT count(*) n FROM d1_migrations').get().n,names.length);
 DB.db.exec("INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','hash','Owner',1); INSERT INTO domains(id,user_id,hostname,zone_id,created_at) VALUES('domain','owner','example.test','zone',1)");
 const db=app.createDb(DB);
 await db.insert(app.mailboxes).values({id:'box',userId:'owner',domainId:'domain',localPart:'owner',signature:'Signature',autoReplyEnabled:true,autoReplySubject:'Away',autoReplyBody:'Back soon'});
 assert.equal(DB.db.prepare("SELECT signature FROM mailboxes WHERE id='box'").get().signature,'Signature');
 assert(DB.db.prepare("PRAGMA table_info(messages)").all().some(column=>column.name==='header_metadata'));
 assert(DB.db.prepare("SELECT name FROM sqlite_master WHERE name='license_settings'").get());
});

test('bootstrap rejects unknown migration history before changing an existing database',async t=>{
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.migrateCleanDatabase(DB);
 DB.db.exec("INSERT INTO d1_migrations(name) VALUES('future-release.sql')");
 await assert.rejects(app.migrateCleanDatabase(DB),/not part of this Mailflare release/);
 assert.deepEqual((await app.getMigrationStatus(DB)).unknown,['future-release.sql']);
});
