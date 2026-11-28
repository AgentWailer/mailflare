// Undo send is a short scheduled delivery, and the composer's address book is read per user.
// Local SQLite with the real migrations; the provider is a probe, so nothing is ever delivered.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd(), dir = mkdtempSync(join(root, 'node_modules', 'undo-send-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const mocks = {
	'@/lib/email/outbound-provider': 'export const getOutboundProviderConfig=async()=>({provider:"resend"});export const sendThroughProvider=(...args)=>globalThis.undoProbe.send(...args);',
	'@/lib/email/attachments': 'export const loadMessageAttachmentContents=async()=>[];export const storeMessageAttachments=async()=>{await globalThis.undoProbe.store?.();return [];};export const cleanupUnpublishedAttachments=async()=>{};export const validateAttachments=()=>{};export const normalizeAttachmentContent=x=>x;',
	'@/lib/email/webhooks': 'export const dispatchWebhooks=async()=>{};',
	'@/lib/mailboxes/audit': 'export const createAuditLog=async()=>{};',
	'@/lib/contacts/gravatar': 'export const importGravatarAvatar=async()=>null;',
};
await build({
	stdin: { contents: `
		export {SqliteDatabase} from './server/runtime/sqlite-database';
		export {applyMigrations} from './server/runtime/migrate';
		export {getDb} from './src/db';
		export {processOutboundQueue,sendEmail} from './src/lib/email/send';
		export {cancelScheduledSend} from './src/lib/email/scheduled';
		export {getUndoDeliveryTime,getUndoSeconds,MAX_UNDO_SECONDS} from './src/app/api/send/utils';
		export {userOwnsDraft} from './src/app/api/drafts/utils';
		export {loadRecipientDirectory} from './src/lib/contacts/recipient-directory';
	`, resolveDir: root },
	outfile: join(dir, 'entry.mjs'), bundle: true, format: 'esm', platform: 'node', packages: 'external',
	alias: { 'cloudflare:workers': './server/runtime/cloudflare-workers.ts', 'next/headers': 'next/headers.js', 'next/server': 'next/server.js' },
	plugins: [{ name: 'no-external-delivery', setup(b) {
		b.onResolve({ filter: /^@\/lib\/(email\/(outbound-provider|attachments|webhooks)|mailboxes\/audit|contacts\/gravatar)$/ }, args => ({ path: args.path, namespace: 'mock' }));
		b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
	} }],
	logLevel: 'silent',
});
const app = await import(pathToFileURL(join(dir, 'entry.mjs')).href);

async function fixture(t) {
	const DB = new app.SqliteDatabase(':memory:');
	t.after(() => DB.db.close());
	await app.applyMigrations(DB, join(root, 'drizzle/migrations'));
	DB.db.exec(`INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','x','Owner',1),('other','other@example.test','x','Other',1);
	INSERT INTO domains(id,user_id,hostname,zone_id,created_at) VALUES('domain','owner','example.test','z',1);
	INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('box','owner','domain','owner',1),('alias','owner','domain','sales',1),('otherbox','other','domain','other',1);`);
	const sent = [], queued = [];
	globalThis.undoProbe = { send: async (_env, _provider, message) => { sent.push(message); return { messageId: `<provider-${sent.length}@example.test>` }; } };
	const env = { DB, OUTBOUND_QUEUE: { send: async (...args) => { queued.push(args); } } };
	return { DB, env, db: app.getDb(env), sent, queued, row: (sql, ...args) => DB.db.prepare(sql).get(...args) };
}
const message = { userId: 'owner', mailboxId: 'box', from: 'owner@example.test', to: '"Chen, Maya" <maya@partner.test>', cc: 'dev@partner.test', bcc: 'archive@partner.test', subject: 'Synthetic undo test', text: 'Body', html: '<p>Body</p>' };

test('the undo window is measured on the server clock and bounded', () => {
	const now = Date.UTC(2026, 10, 26, 12, 0, 0);
	assert.equal(app.getUndoDeliveryTime('10', now).getTime(), now + 10_000);
	assert.equal(app.getUndoDeliveryTime(30, now).getTime(), now + 30_000);
	assert.equal(app.getUndoDeliveryTime(String(app.MAX_UNDO_SECONDS), now).getTime(), now + 120_000);
	for (const refused of [undefined, '', '0', 0, '-5', '121', 9999, '1.5', 1.5, '10s', ' 10', '1e2', 'NaN', Number.NaN, Infinity, '99999999999999999999'])
		assert.equal(app.getUndoDeliveryTime(refused, now), null, `refused: ${String(refused)}`);
});

test('a message sent with an undo window waits in the outbox and reaches no provider', async t => {
	const f = await fixture(t);
	const result = await app.sendEmail(f.env, { ...message, scheduledAt: app.getUndoDeliveryTime('10') });
	assert.equal(result.scheduled, true);
	assert.equal(f.sent.length, 0, 'nothing leaves during the window');
	assert.equal(f.row('SELECT status FROM messages WHERE id=?', result.messageId).status, 'queued');
	assert.equal(f.queued.length, 1);
	const [payload, options] = f.queued[0];
	assert.equal(payload.kind, 'email.scheduled');
	assert(options.delaySeconds >= 1 && options.delaySeconds <= 10, `queue delay follows the window: ${options.delaySeconds}`);
});

test('undo returns the complete message to Drafts, and a late delivery attempt sends nothing', async t => {
	const f = await fixture(t);
	const result = await app.sendEmail(f.env, { ...message, scheduledAt: app.getUndoDeliveryTime('10') });
	assert.equal(await app.cancelScheduledSend(f.db, result.messageId), true);
	const draft = f.row('SELECT user_id as userId,status,to_addr,cc_addr,bcc_addr,subject,html_body FROM messages WHERE id=?', result.messageId);
	assert.equal(app.userOwnsDraft(draft, 'owner'), true, 'the composer can reopen it as the sender\'s draft');
	assert.equal(app.userOwnsDraft(draft, 'other'), false);
	assert.deepEqual([draft.to_addr, draft.cc_addr, draft.bcc_addr, draft.subject, draft.html_body], ['"Chen, Maya" <maya@partner.test>', 'dev@partner.test', 'archive@partner.test', 'Synthetic undo test', '<p>Body</p>']);
	// The queue still holds the delayed message; delivering it after the undo must do nothing.
	await app.processOutboundQueue(f.env, f.queued[0][0]);
	assert.equal(f.sent.length, 0);
	assert.equal(f.row('SELECT status FROM messages WHERE id=?', result.messageId).status, 'draft');
	assert.equal(await app.cancelScheduledSend(f.db, result.messageId), false, 'a second undo has nothing left to cancel');
});

test('when the window passes, the message is delivered once with every recipient, and undo is refused', async t => {
	const f = await fixture(t);
	const result = await app.sendEmail(f.env, { ...message, scheduledAt: app.getUndoDeliveryTime('1') });
	f.DB.db.prepare('UPDATE outbound_jobs SET scheduled_at=? WHERE message_id=?').run(Math.floor(Date.now() / 1000) - 2, result.messageId);
	await app.processOutboundQueue(f.env, f.queued[0][0]);
	await app.processOutboundQueue(f.env, f.queued[0][0]);
	assert.equal(f.sent.length, 1, 'a redelivered queue message does not send twice');
	assert.deepEqual([f.sent[0].to, f.sent[0].cc, f.sent[0].bcc], [['"Chen, Maya" <maya@partner.test>'], ['dev@partner.test'], ['archive@partner.test']]);
	assert.equal(f.row('SELECT status FROM messages WHERE id=?', result.messageId).status, 'sent');
	assert.equal(await app.cancelScheduledSend(f.db, result.messageId), false);
	assert.equal(f.row('SELECT status FROM messages WHERE id=?', result.messageId).status, 'sent', 'a sent message never becomes a draft again');
});

test('the address book ranks who this user wrote to and never shows another user\'s contacts', async t => {
	const f = await fixture(t);
	const owner = { id: 'owner', email: 'owner@example.test', role: 'user' };
	globalThis.undoProbe.send = async () => ({ messageId: '<sent@example.test>' });
	await app.sendEmail(f.env, { ...message, to: 'Maya Chen <maya@partner.test>', cc: undefined, bcc: undefined });
	await app.sendEmail(f.env, { ...message, to: 'maya@partner.test, dev@partner.test', cc: 'sales@example.test', bcc: undefined });
	// A queued message with an undo window counts: the owner did mean to write there.
	await app.sendEmail(f.env, { ...message, to: 'waiting@partner.test', cc: undefined, bcc: undefined, scheduledAt: app.getUndoDeliveryTime('30') });
	f.DB.db.exec(`INSERT INTO contacts(id,user_id,email,display_name,source,blocked,last_seen_at,created_at) VALUES
		('c1','owner','newsletter@shop.test','Shop','inbound',0,1700000000,1),
		('c2','owner','blocked@bad.test','Bad','inbound',1,1700000001,1),
		('c3','other','secret@other-user.test','Other User Contact','manual',0,1700000002,1);
		INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at) VALUES
		('foreign','other','otherbox','outbound','other@example.test','private@other-user.test','sent',1700000003),
		('draft','owner','box','outbound','owner@example.test','never-sent@partner.test','draft',1700000004),
		('inbound','owner','box','inbound','stranger@unknown.test','owner@example.test','received',1700000005);`);
	const list = await app.loadRecipientDirectory(f.db, owner);
	assert.deepEqual(list.map(entry => [entry.email, entry.sends]), [['maya@partner.test', 2], ['dev@partner.test', 1], ['waiting@partner.test', 1], ['newsletter@shop.test', 0]]);
	assert.equal(list[0].name, 'Maya Chen');
	const emails = new Set(list.map(entry => entry.email));
	for (const hidden of ['secret@other-user.test', 'private@other-user.test', 'blocked@bad.test', 'never-sent@partner.test', 'stranger@unknown.test', 'owner@example.test', 'sales@example.test'])
		assert.equal(emails.has(hidden), false, `${hidden} must not be suggested`);
	const others = await app.loadRecipientDirectory(f.db, { id: 'other', email: 'other@example.test', role: 'user' });
	assert.deepEqual(others.map(entry => entry.email).sort(), ['private@other-user.test', 'secret@other-user.test']);
});

test('the undo window starts when the message is ready to wait, not while its files are still being stored', async t => {
	const f = await fixture(t);
	// A large attachment on a slow connection to storage: most of a short window would be gone.
	globalThis.undoProbe.store = () => new Promise(resolve => setTimeout(resolve, 400));
	const asked = Date.now();
	const result = await app.sendEmail(f.env, { ...message, undoSeconds: 2 });
	const returned = Date.now();
	assert.equal(result.scheduled, true);
	assert(returned - asked >= 380, 'storing took its time');
	assert(result.undoUntil.getTime() >= asked + 2380, `the whole window follows the upload: ${result.undoUntil.getTime() - asked} ms after the request`);
	assert(result.undoUntil.getTime() - returned > 1500, 'the sender still has the window they chose');
	const job = f.row('SELECT scheduled_at, status, payload FROM outbound_jobs WHERE message_id=?', result.messageId);
	assert.equal(job.status, 'queued');
	assert.equal(job.scheduled_at * 1000, Math.floor(result.undoUntil.getTime() / 1000) * 1000, 'delivery waits for the same moment the sender was told');
	assert.equal(JSON.parse(job.payload).undoSeconds, undefined, 'the delivery itself is not held a second time');
	assert.equal(f.sent.length, 0);
});

test('a time the sender picked wins over an undo window, and no window means no deadline', async t => {
	const f = await fixture(t);
	const later = new Date(Date.now() + 3_600_000);
	const scheduled = await app.sendEmail(f.env, { ...message, scheduledAt: later, undoSeconds: 10 });
	assert.equal(scheduled.undoUntil, undefined);
	assert.equal(f.row('SELECT scheduled_at FROM outbound_jobs WHERE message_id=?', scheduled.messageId).scheduled_at, Math.floor(later.getTime() / 1000));
	const direct = await app.sendEmail(f.env, { ...message });
	assert.equal(direct.undoUntil, undefined);
	assert.equal(direct.scheduled, undefined);
	assert.equal(app.getUndoSeconds('10'), 10);
	for (const refused of [undefined, '', '0', '-5', '1.5', '121', 'soon', 0, 500]) assert.equal(app.getUndoSeconds(refused), null, `refused: ${String(refused)}`);
});
