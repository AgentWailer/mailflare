import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, eq, ne } from 'drizzle-orm';

const directory = mkdtempSync(join(process.cwd(), 'node_modules', 'message-page-access-path-'));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({ stdin: { contents: `
 export { SqliteDatabase } from './server/runtime/sqlite-database';
 export { applyMigrations } from './server/runtime/migrate';
 export { createDb } from './src/db';
 export { messages } from './src/db/schema';
 export { loadConversationPage, loadConversationRows } from './src/app/api/messages/utils';
`, resolveDir: process.cwd() }, outfile: join(directory, 'app.mjs'), bundle: true,
 platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', logLevel: 'silent' });
const app = await import(pathToFileURL(join(directory, 'app.mjs')).href);

test('bounded page hydration and starred traversal use metadata indexes without ANALYZE beside 60,000 messages', async t => {
 const DB = new app.SqliteDatabase(':memory:'); t.after(() => DB.db.close());
 await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES
 ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES
 ('box','owner','domain','owner','personal',1),('foreign','other','domain','other','personal',1);`);
 const insert = DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,thread_id,starred,subject,text_body,html_body,created_at)
 VALUES(?,?,?,'inbound','sender@example.test','owner@example.test',?,?,?,'Subject','Private body','<p>Private body</p>',?)`);
 const add = (id, { user = 'owner', box = 'box', status = 'received', thread = null, starred = 0, at = 1 } = {}) =>
  insert.run(id, user, box, status, thread, starred, at);
 DB.db.transaction(() => {
  for (let i = 0; i < 60000; i++) add(`archive-${i}`, { status: 'archived' });
  for (let i = 0; i < 32; i++) {
   add(`old-${String(i).padStart(2, '0')}`, { thread: `thread-${i}`, starred: 1, at: 10 + i });
   add(`new-${String(i).padStart(2, '0')}`, { thread: `thread-${i}`, starred: 1, at: 100 + i });
  }
  add('standalone', { starred: 1, at: 200 });
  add('tie-a', { thread: 'tie', starred: 1, at: 300 });
  add('tie-z', { thread: 'tie', starred: 1, at: 300 });
  add('wrong-status', { status: 'spam', starred: 1, at: 400 });
  add('wrong-mailbox', { user: 'other', box: 'foreign', starred: 1, at: 500 });
  add('not-starred', { at: 600 });
 })();
 assert(DB.db.prepare("PRAGMA index_list('messages')").all().some(index => index.name === 'sqlite_autoindex_messages_1' && index.origin === 'pk'));
 assert.equal(DB.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='sqlite_stat1'").get().n, 0, 'do not depend on ANALYZE statistics');
 const queries = [], prepare = DB.prepare.bind(DB);
 DB.prepare = sql => { queries.push(sql); return prepare(sql); };
 const db = app.createDb(DB), messages = app.messages;
 const where = and(eq(messages.mailboxId, 'box'), eq(messages.direction, 'inbound'), eq(messages.status, 'received'), eq(messages.starred, true), ne(messages.status, 'template'));
 const ids = ['wrong-mailbox', 'wrong-status', 'not-starred', 'new-00', 'new-31', 'missing'];
 const hydrated = await app.loadConversationRows({ db, where, ids });
 assert.deepEqual(hydrated.map(row => row.id).sort(), ['new-00', 'new-31']);
 assert(hydrated.every(row => row.createdAt instanceof Date && row.starred === true && row.read === false), 'forced SQL source preserves Drizzle timestamp and boolean decoders');
 assert(hydrated.every(row => !('textBody' in row) && !('htmlBody' in row) && !('headerMetadata' in row)));
 const hydrateSql = queries.find(query => query.includes('indexed by sqlite_autoindex_messages_1'));
 const plan = sql => DB.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array((sql.match(/\?/g) || []).length).fill(null)).map(row => row.detail).join('\n');
 const hydrationPlan = plan(hydrateSql);
 assert.match(hydrationPlan, /SEARCH messages USING INDEX sqlite_autoindex_messages_1 \(id=\?\)/);
 assert(!hydrationPlan.includes('SCAN messages'), hydrationPlan);
 const requests = queries.length;
 assert.deepEqual(await app.loadConversationRows({ db, where, ids: [] }), []);
 assert.equal(queries.length, requests, 'empty pages need no hydration query');

 const expected = ['tie-z', 'standalone', ...Array.from({ length: 32 }, (_, i) => `new-${String(31 - i).padStart(2, '0')}`)];
 const pages = [];
 for (let offset = 0; offset < 50; offset += 25) {
  const normal = await app.loadConversationPage({ db, where, offset, limit: 25 });
  const optimized = await app.loadConversationPage({ db, where, offset, limit: 25, metadataOnlyScan: true });
  assert.deepEqual(optimized, normal, 'index choice must not change head selection, ties, or total');
  assert.equal(optimized.total, expected.length); pages.push(...optimized.ids);
  const rows = await app.loadConversationRows({ db, where, ids: optimized.ids });
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual(optimized.ids.map(id => byId.get(id)?.id), expected.slice(offset, offset + 25), 'page ordering is preserved when hydrating by ID');
 }
 assert.deepEqual(pages, expected, 'deep-page traversal neither duplicates nor drops conversations');
 assert.deepEqual(await app.loadConversationPage({ db, where, offset: 100, limit: 25, metadataOnlyScan: true }), { ids: [], total: expected.length });
 const starPlans = queries.filter(query => query.includes('indexed by messages_counts_cover_idx')).map(plan);
 assert(starPlans.length >= 2);
 for (const detail of starPlans) assert.match(detail, /SEARCH messages USING COVERING INDEX messages_counts_cover_idx/, detail);
 t.diagnostic(JSON.stringify({ fixtureRows: 60070, hydrationPlan, starredPlans: [...new Set(starPlans)] }));
});
