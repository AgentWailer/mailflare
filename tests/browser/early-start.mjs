// Starting the built application a second time: the page asks for the session, the mailboxes and the
// list at once, before the scripts have loaded, and the application uses those answers instead of
// asking three times in a row. Production assets and router; private APIs answer with synthetic data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const temporary = mkdtempSync(join(tmpdir(), 'mailflare-early-start-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const API_DELAY_MS = 250;

const folders = ['inbox', 'promotions', 'social', 'invoices', 'orders', 'starred', 'all', 'snoozed', 'sent', 'scheduled', 'drafts', 'archived', 'spam', 'trash'];
const counts = { folders: Object.fromEntries(folders.map(key => [key, { total: 3, unread: 0 }])), customFolders: {}, mailboxes: [] };
const messages = Array.from({ length: 3 }, (_, index) => ({ id: `mail-${index}`, mailboxId: 'box', direction: 'inbound', status: 'received', category: 'primary', read: true, starred: false, fromAddr: 'Sender <sender@example.test>', toAddr: 'owner@example.test', subject: `Synthetic mail ${index}`, snippet: 'Preview', labels: [], createdAt: '2026-10-25T12:00:00Z' }));
function answer(path) {
	if (path === '/api/auth/me') return { user: { id: 'user', email: 'owner@example.test', name: 'Test User', role: 'admin', isPrimaryAdmin: true, hasAvatar: false }, hasMailboxes: true, isSetup: true };
	if (path === '/api/mailboxes') return { mailboxes: [{ id: 'box', domainId: 'domain', localPart: 'owner', hostname: 'example.test', displayName: 'Test User', isPrimary: true, type: 'personal', permission: 'full_access', senderAddresses: ['owner@example.test'] }] };
	if (path === '/api/messages') return { messages, total: 3, offset: 0, limit: 25 };
	if (path === '/api/messages/counts') return { counts };
	if (path === '/api/branding') return { appName: 'Mailflare', hasCustomIcon: false };
	if (path === '/api/agent/availability') return { enabled: false };
	return { folders: [], accounts: [], jobs: [], job: null, messages: [], hiddenLabelIds: [], ok: true };
}

const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let preview, browser, serverLog = '';

/** Every API request of one page load with when it was sent and answered, in order of sending. */
function watch(page, { signedIn = true } = {}) {
	let log = [];
	page.route('**/api/**', async route => {
		const request = route.request(), url = new URL(request.url());
		const entry = { path: url.pathname, url: url.pathname + url.search, background: request.headers()['x-mailflare-preload'] === '1', sent: Date.now(), answered: null };
		log.push(entry);
		await pause(API_DELAY_MS);
		entry.answered = Date.now();
		if (!signedIn && url.pathname === '/api/auth/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' }).catch(() => {});
		await route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer(url.pathname)) }).catch(() => {});
	});
	return { take: () => { const taken = log; log = []; return taken; } };
}
const only = (log, path) => log.filter(entry => entry.path === path && !entry.background);

try {
	preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: temporary, CLOUDFLARE_REMOTE_BINDINGS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
	for (const stream of [preview.stdout, preview.stderr]) stream.on('data', data => serverLog += data.toString());
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		try { if ((await fetch(`${origin}/inbox`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* not listening yet */ }
		if (preview.exitCode !== null) throw new Error('Local preview exited');
		await pause(200);
	}
	assert(ready, 'production preview starts');
	browser = await chromium.launch({ headless: true, executablePath: process.env.MAILFLARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });

	for (const width of [1280, 390]) {
		const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 768 });
		const page = await context.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		const requests = watch(page);
		const listShown = () => page.getByText('Synthetic mail 0', { exact: true }).first().waitFor({ timeout: 30000 });

		// The first visit of a browser has nothing to go on: one request after the other, as before.
		await page.goto(`${origin}/inbox`, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await listShown();
		await pause(300);
		const first = requests.take();
		for (const path of ['/api/auth/me', '/api/mailboxes', '/api/messages']) assert.equal(only(first, path).length, 1, `first visit asks once for ${path}`);
		const firstList = only(first, '/api/messages')[0];
		assert(firstList.sent >= only(first, '/api/mailboxes')[0].answered, 'on a first visit the list waits for the mailboxes');
		assert(only(first, '/api/mailboxes')[0].sent >= only(first, '/api/auth/me')[0].answered, 'and the mailboxes wait for the session');
		const noted = await page.evaluate(() => JSON.parse(localStorage.getItem('mailflare-start-requests')));
		assert.deepEqual(noted.lists, [['/inbox', firstList.url]], 'the page noted the list it showed first');
		assert.equal(noted.scope, await page.evaluate(() => localStorage.getItem('mailflare-session-scope')));

		// The next start asks for all three at once and the application asks for none of them again.
		await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
		await listShown();
		await pause(300);
		const second = requests.take();
		for (const path of ['/api/auth/me', '/api/mailboxes', '/api/messages']) assert.equal(only(second, path).length, 1, `the next start still asks once for ${path}`);
		const [session, mailboxes, listRequest] = ['/api/auth/me', '/api/mailboxes', '/api/messages'].map(path => only(second, path)[0]);
		assert.equal(listRequest.url, firstList.url, 'the early list is the one the page shows');
		assert(mailboxes.sent < session.answered && listRequest.sent < session.answered, 'mailboxes and list no longer wait for the session');
		assert(listRequest.sent - session.sent < API_DELAY_MS / 2, `all three leave together (${listRequest.sent - session.sent} ms apart)`);
		assert.equal(await page.evaluate(() => Object.keys(window.__mailflareEarly?.requests ?? {}).length), 0, 'every early answer was taken');
		assert.deepEqual(errors, []);

		// Another page of the app has no noted list: the session and mailboxes are early, nothing is guessed.
		await page.goto(`${origin}/sent`, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await listShown();
		await pause(300);
		const other = requests.take();
		assert.equal(only(other, '/api/messages').length, 1, 'a page without a noted list asks for its own list once');
		assert.match(only(other, '/api/messages')[0].url, /folder=sent|status=sent|sent/);
		assert.equal(only(other, '/api/auth/me').length, 1);
		assert.deepEqual(errors, []);
		await context.close();
	}

	// A browser that was never signed in sends nothing ahead: no mailbox or list request leaves it.
	{
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		const requests = watch(page, { signedIn: false });
		await page.goto(`${origin}/setup`, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await page.getByRole('combobox').first().waitFor({ timeout: 30000 });
		await pause(600);
		const log = requests.take();
		assert.equal(only(log, '/api/mailboxes').length, 0, 'no mailbox request for a visitor');
		assert.equal(only(log, '/api/messages').length, 0, 'no list request for a visitor');
		assert.equal(await page.evaluate(() => window.__mailflareEarly), undefined);
		await context.close();
	}
	console.log(JSON.stringify({ earlyStartRequests: true }));
} catch (error) {
	if (serverLog) console.error(serverLog.split('\n').filter(line => !/^(GET|POST) /.test(line)).join('\n').slice(-2000));
	throw error;
} finally {
	await browser?.close();
	if (preview) {
		preview.kill('SIGTERM');
		await new Promise(resolve => { if (preview.exitCode !== null) return resolve(); preview.once('exit', resolve); setTimeout(() => { preview.kill('SIGKILL'); resolve(); }, 5000).unref(); });
	}
	rmSync(temporary, { recursive: true, force: true });
}
