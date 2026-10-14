import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(root, 'node_modules', 'mailflare-security-test-'));
after(() => rmSync(directory, { recursive: true, force: true }));
writeFileSync(join(directory, 'headers.mjs'), 'export async function cookies() { return { get: name => name==="ep_session" && globalThis.__securityCookie ? {value:globalThis.__securityCookie} : undefined }; }');
await build({ stdin: { contents: `
 export { SqliteDatabase } from './server/runtime/sqlite-database.ts';
 export { applyMigrations } from './server/runtime/migrate.ts';
 export { createSession } from './src/lib/auth/session.ts';
 export { GET as listMailboxes, POST as createMailbox } from './src/app/api/mailboxes/route.ts';
 export { GET as listFolders, POST as createFolder } from './src/app/api/folders/route.ts';
 export { GET as getContact, PATCH as updateContact } from './src/app/api/contacts/route.ts';
 export { GET as listDomains, POST as createDomain } from './src/app/api/domains/route.ts';
 export { GET as sharedFile } from './src/app/api/shared-files/[id]/route.ts';
 export { GET as message } from './src/app/api/messages/[messageId]/route.ts';
 export { GET as metadata } from './src/app/api/messages/[messageId]/metadata/route.ts';
 export { GET as original } from './src/app/api/messages/[messageId]/original/route.ts';
 export { GET as backupDownload } from './src/app/api/backups/[id]/download/route.ts';
 export { POST as logout } from './src/app/api/auth/logout/route.ts';
 export { GET as attachment } from './src/app/api/messages/[messageId]/attachments/[attachmentId]/route.ts';
`, resolveDir: root, sourcefile: 'security-entry.ts' }, outfile: join(directory, 'entry.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', tsconfig: join(root, 'tsconfig.json'), alias: { 'next/headers': join(directory, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts' }, logLevel: 'silent' });
const app = await import(pathToFileURL(join(directory, 'entry.mjs')).href);

async function fixture(t) {
 const database = new app.SqliteDatabase(':memory:');
 t.after(() => { database.db.close(); delete globalThis.__mailflareNodeEnv; delete globalThis.__securityCookie; });
 await app.applyMigrations(database, join(root, 'drizzle/migrations'));
 database.db.exec(`
 INSERT INTO users (id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','admin',1);
 INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes (id,user_id,domain_id,local_part,type,created_at) VALUES ('mailbox','owner','domain','owner','personal',1),('other-mailbox','other','domain','other','personal',1);
 INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at) VALUES ('message','owner','mailbox','inbound','sender@example.test','owner@example.test','received',1);
 INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at) VALUES ('file','message','invoice.html','text/html',7,'private/file',1);
 `);
 const reads = [];
 const env = { DB: database, MAILFLARE_RUNTIME: 'node', BUCKET: { get: async key => { reads.push(key); return { body: 'content', arrayBuffer:async()=>new TextEncoder().encode('From: sender@example.test\r\n\r\nContent').buffer, size: 7, writeHttpMetadata: headers => headers.set('Content-Type', 'text/html') }; } } };
 globalThis.__mailflareNodeEnv = env;
 const tokens = {};
 for (const id of ['owner', 'other']) tokens[id] = await app.createSession(env, id);
 const request = (user, path = '/api/mailboxes', method = 'GET') => new Request('https://mailflare.test'+path, { method, headers: user ? { Authorization: 'Bearer '+(tokens[user] ?? 'invalid') } : {}, ...(method==='POST' ? { body: 'not JSON' } : {}) });
 const download = user => app.attachment(request(user, '/api/messages/message/attachments/file'), { params: Promise.resolve({ messageId: 'message', attachmentId: 'file' }) });
 const shared = () => app.sharedFile(request(null, '/api/shared-files/link'), { params: Promise.resolve({ id: 'link' }) });
 return { database, env, reads, request, download, shared, tokens };
}

test('mailbox listing and creation return 401 before parsing or touching mailbox state', async t => {
 const f = await fixture(t);
 for (const user of [null, 'invalid']) {
  const list = await app.listMailboxes(f.request(user));
  assert.equal(list.status, 401); assert.deepEqual(await list.json(), { error: 'Unauthorized' });
  assert.equal((await app.createMailbox(f.request(user, '/api/mailboxes', 'POST'))).status, 401);
 }
 assert.equal(f.database.db.prepare('SELECT count(*) n FROM mailboxes').get().n, 2);
});

test('an administrator cannot list or download another user’s personal mailbox attachments', async t => {
 const f = await fixture(t);
 const listed = await app.listMailboxes(f.request('other'));
 assert.equal(listed.status, 200); assert.deepEqual((await listed.json()).mailboxes.map(m => m.id), ['other-mailbox']);
 assert.equal((await f.download(null)).status, 401);
 assert.equal((await f.download('other')).status, 404);
 assert.deepEqual(f.reads, []);
 const own = await f.download('owner'); assert.equal(own.status, 200);
 assert.equal(own.headers.get('Cache-Control'), 'private, no-store');
 assert.equal(own.headers.get('X-Content-Type-Options'), 'nosniff'); assert.match(own.headers.get('Content-Security-Policy'), /sandbox/);
});

test('expired, missing and deleted public attachment links never fetch object contents', async t => {
 const f = await fixture(t);
 assert.equal((await f.shared()).status, 404);
 const now = Math.floor(Date.now()/1000);
 f.database.db.prepare('INSERT INTO shared_attachment_links(id,attachment_id,expires_at,created_at) VALUES (?,?,?,?)').run('link','file',now-1,now);
 assert.equal((await f.shared()).status, 404);
 f.database.db.prepare('UPDATE shared_attachment_links SET expires_at=?').run(now+3600);
 f.database.db.prepare('UPDATE message_attachments SET trashed_at=?').run(now);
 assert.equal((await f.shared()).status, 404); assert.deepEqual(f.reads, []);
 f.database.db.prepare('UPDATE message_attachments SET trashed_at=NULL').run();
 const restored = await f.shared(); assert.equal(restored.status, 200); assert.equal(await restored.text(), 'content');
 assert.equal(restored.headers.get('Cache-Control'), 'private, no-store');
 assert.match(restored.headers.get('Content-Disposition'), /^attachment;/);
});

test('disabled mailbox and disabled user sessions cannot download protected attachments', async t => {
 const f = await fixture(t);
 f.database.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
 assert.equal((await f.download('owner')).status, 404);
 f.database.db.exec("UPDATE mailboxes SET disabled=0 WHERE id='mailbox'; UPDATE users SET disabled=1 WHERE id='owner'");
 assert.equal((await f.download('owner')).status, 401);
 assert.equal((await app.listMailboxes(f.request('owner'))).status, 401);
 assert.deepEqual(f.reads, []);
});


test('folder, contact and domain routes return 401 for anonymous callers before parsing', async t => {
 const f = await fixture(t);
 for (const handler of [app.listFolders, app.getContact, app.listDomains]) {
  assert.equal((await handler(f.request(null))).status, 401);
 }
 for (const handler of [app.createFolder, app.updateContact, app.createDomain]) {
  assert.equal((await handler(f.request(null, '/api/test', 'POST'))).status, 401);
 }
});


test('shared attachment access requires a current explicit grant and revocation takes effect', async t => {
 const f = await fixture(t);
 f.database.db.exec("UPDATE mailboxes SET type='shared' WHERE id='mailbox'");
 assert.equal((await f.download('other')).status, 404);
 f.database.db.exec("INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('grant','mailbox','other','read_only',1)");
 assert.equal((await f.download('other')).status, 200);
 f.database.db.exec("DELETE FROM mailbox_access WHERE id='grant'");
 assert.equal((await f.download('other')).status, 404);
 assert.deepEqual(f.reads, ['private/file']);
});


test('legacy folder writes reject cross-origin cookie requests before changing labels', async t => {
 const f = await fixture(t);globalThis.__securityCookie=f.tokens.owner;
 for(const headers of [{Origin:'https://untrusted.example.test','Sec-Fetch-Site':'same-site'},{Origin:'https://evil.test','Sec-Fetch-Site':'same-origin'},{}]) {
  const request=new Request('https://mailflare.test/api/folders',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({mailboxId:'mailbox',name:'Unwanted'})});
  assert.equal((await app.createFolder(request)).status,403);
 }
 assert.equal(f.database.db.prepare('SELECT count(*) n FROM folders').get().n,0);
 const valid=new Request('https://mailflare.test/api/folders',{method:'POST',headers:{Origin:'https://mailflare.test','Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({mailboxId:'mailbox',name:'Valid label'})});
 assert.equal((await app.createFolder(valid)).status,200);
 assert.equal(f.database.db.prepare('SELECT count(*) n FROM folders').get().n,1);
});

test('message contents, metadata and raw originals reject anonymous and foreign administrators',async t=>{
 const f=await fixture(t);f.database.db.prepare("UPDATE messages SET raw_r2_key='private/raw' WHERE id='message'").run();
 for(const handler of [app.message,app.metadata,app.original]) {
  const params={params:Promise.resolve({messageId:'message'})};
  assert.equal((await handler(f.request(null),params)).status,401);
  assert.equal((await handler(f.request('other'),params)).status,404);
 }
 assert.deepEqual(f.reads,[]);
 assert.equal((await app.message(f.request('owner'),{params:Promise.resolve({messageId:'message'})})).status,200);
});

test('cross-origin logout cannot invalidate the current browser session',async t=>{
 const f=await fixture(t);globalThis.__securityCookie=f.tokens.owner;
 const response=await app.logout(new Request('https://mailflare.test/api/auth/logout',{method:'POST',headers:{Origin:'https://untrusted.example.test','Sec-Fetch-Site':'same-site'}}));
 assert.equal(response.status,403);assert.equal(f.database.db.prepare('SELECT count(*) n FROM sessions').get().n,2);
});


test('database backups are readable only by the primary administrator and never browser-cached',async t=>{
 const f=await fixture(t);f.database.db.exec("INSERT INTO backups(id,status,trigger,r2_key,filename,created_at) VALUES('backup','completed','manual','private/backup','backup.json',1)");
 const params={params:Promise.resolve({id:'backup'})};
 assert.equal((await app.backupDownload(f.request(null),params)).status,403);assert.equal((await app.backupDownload(f.request('other'),params)).status,403);assert.deepEqual(f.reads,[]);
 f.database.db.exec("UPDATE users SET role='admin',is_primary_admin=1 WHERE id='owner'");const response=await app.backupDownload(f.request('owner'),params);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('Content-Type'),'application/json');
});
