// The built application in other languages: the page names one long-cached catalogue script instead of
// carrying the catalogue, and still reads correctly when that script is late or cannot be loaded.
// Production assets and router; private APIs answer with synthetic data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'mailflare-locale-catalog-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const en = JSON.parse(readFileSync(join(root, 'src/lib/i18n/en.json'), 'utf8'));
const de = JSON.parse(readFileSync(join(root, 'public/locales/de.json'), 'utf8'));
const ar = JSON.parse(readFileSync(join(root, 'public/locales/ar.json'), 'utf8'));

const folders = ['inbox', 'promotions', 'social', 'invoices', 'orders', 'starred', 'all', 'snoozed', 'sent', 'scheduled', 'drafts', 'archived', 'spam', 'trash'];
const counts = { folders: Object.fromEntries(folders.map(key => [key, { total: 3, unread: 0 }])), customFolders: {}, mailboxes: [] };
const messages = Array.from({ length: 3 }, (_, index) => ({ id: `mail-${index}`, mailboxId: 'box', direction: 'inbound', status: 'received', category: 'primary', read: true, starred: false, fromAddr: 'Sender <sender@example.test>', toAddr: 'owner@example.test', subject: `Synthetic mail ${index}`, snippet: 'Preview', labels: [], createdAt: '2026-10-25T12:00:00Z' }));
function signedIn(path) {
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

/** Opens the inbox in a browser asking for `locale`; `catalog` makes the catalogue script late or unreachable. */
async function openInbox({ locale, catalog = 'served', width = 1280 }) {
	const context = await browser.newContext({ viewport: { width, height: 900 }, locale, hasTouch: width < 768 });
	const page = await context.newPage();
	const errors = [], requested = [];
	let document = null, script = null;
	page.on('pageerror', error => errors.push(error.message));
	page.on('request', request => requested.push(new URL(request.url()).pathname));
	page.on('response', async response => {
		const path = new URL(response.url()).pathname;
		if (path === '/inbox' && response.request().resourceType() === 'document') document = await response.text().catch(() => null);
		if (/\/_next\/static\/locales\//.test(path)) script = { path, cache: response.headers()['cache-control'] };
	});
	await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(signedIn(new URL(route.request().url()).pathname)) }));
	await page.route('**/_next/static/locales/**', async route => {
		if (catalog === 'unreachable') return route.abort('failed');
		if (catalog === 'late') await pause(1500);
		return route.continue();
	});
	await page.goto(`${origin}/inbox`, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.getByText('Synthetic mail 0', { exact: true }).first().waitFor({ timeout: 30000 });
	return { context, page, errors, requested, document: () => document, script: () => script };
}
const SETUP_HEADING = 'setup.prepareTitle';
const catalogRequests = requested => requested.filter(path => path.startsWith('/locales/') || path.includes('/_next/static/locales/'));

try {
	preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...process.env, XDG_CONFIG_HOME: temporary, CLOUDFLARE_REMOTE_BINDINGS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
	for (const stream of [preview.stdout, preview.stderr]) stream.on('data', data => serverLog += data.toString());
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		try { if ((await fetch(`${origin}/inbox`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* not listening yet */ }
		if (preview.exitCode !== null) throw new Error('Local preview exited');
		await pause(200);
	}
	assert(ready, 'production preview starts');
	browser = await chromium.launch({ headless: true, executablePath: process.env.MAILFLARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });

	// German: the page stays small, the catalogue arrives as one immutable script, nothing else is fetched for it.
	for (const width of [1280, 390]) {
		const { context, page, errors, requested, document, script } = await openInbox({ locale: 'de-DE', width });
		assert.equal(await page.locator('html').getAttribute('lang'), 'de');
		if (width === 1280) await page.locator('a[href="/sent"]').filter({ hasText: de['navigation.sent'] }).first().waitFor();
		// On a phone the search controls are folded away; their translated label is in the page all the same.
		await page.locator(`button[aria-label="${de['search.advanced']}"]`).first().waitFor({ state: 'attached' });
		const html = document();
		assert(html, 'the page document was read');
		assert(html.length < 60_000, `a German page does not carry its catalogue (${html.length} bytes)`);
		for (const key of ['settings.mailLinks.description', 'settings.undoSend.description']) {
			assert(de[key]?.length > 30, `${key} is a German sentence`);
			assert(!html.includes(de[key]), `the page does not carry ${key}, text of a screen that is not open`);
		}
		assert.deepEqual(catalogRequests(requested), [script().path], 'exactly one catalogue is requested');
		assert.match(script().path, /^\/_next\/static\/locales\/[0-9a-f]{16}\/de\.js$/);
		assert.match(script().cache, /max-age=31536000.*immutable/, 'the catalogue script is cached for good');
		assert.deepEqual(errors, []);
		await context.close();
	}

	// English is a catalogue script like any other; the startup scripts no longer contain it.
	{
		const { context, page, errors, requested } = await openInbox({ locale: 'en-US' });
		await page.locator('a[href="/sent"]').filter({ hasText: en['navigation.sent'] }).first().waitFor();
		assert.deepEqual(catalogRequests(requested).map(path => path.split('/').at(-1)), ['en.js']);
		const startup = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\/_next\/static\/chunks\/.*\.js$/.test(entry.name)).map(entry => entry.name));
		const marker = en['settings.mailLinks.description'];
		assert(marker.length > 30);
		for (const url of startup) assert(!(await (await fetch(url)).text()).includes(marker), `${new URL(url).pathname} carries English interface text`);
		assert.deepEqual(errors, []);
		await context.close();
	}

	// A catalogue that has not translated everything shows English for the rest, from its own script.
	{
		const untranslated = Object.keys(en).find(key => !(key in ar) && key === 'search.advanced') ?? null;
		const { context, page, errors, requested } = await openInbox({ locale: 'ar' });
		assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
		await page.locator('a[href="/sent"]').filter({ hasText: ar['navigation.sent'] }).first().waitFor();
		if (untranslated) await page.locator(`button[aria-label="${en[untranslated]}"]`).first().waitFor({ state: 'attached' });
		assert.deepEqual(catalogRequests(requested).map(path => path.split('/').at(-1)), ['ar.js']);
		assert.deepEqual(errors, []);
		await context.close();
	}

	// The script arrives after the application code: hydration waits for it instead of rendering keys.
	for (const locale of ['de-DE', 'en-US']) {
		const { context, page, errors } = await openInbox({ locale, catalog: 'late' });
		const text = locale === 'de-DE' ? de : en;
		await page.locator('a[href="/sent"]').filter({ hasText: text['navigation.sent'] }).first().waitFor();
		assert.equal(await page.getByText('navigation.sent', { exact: true }).count(), 0, 'no bare key is shown');
		assert.deepEqual(errors, [], 'a late catalogue causes no hydration error');
		await context.close();
	}

	// The script cannot be loaded at all: the plain catalogue file still translates the interface.
	{
		const { context, page, requested } = await openInbox({ locale: 'de-DE', catalog: 'unreachable' });
		await page.locator('a[href="/sent"]').filter({ hasText: de['navigation.sent'] }).first().waitFor();
		assert(requested.includes('/locales/de.json'), 'falls back to the plain catalogue');
		await context.close();
	}

	// Choosing another language while the app is open loads that language's script and keeps the choice.
	{
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
		const page = await context.newPage();
		const errors = [], requested = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('request', request => requested.push(new URL(request.url()).pathname));
		await page.route('**/api/**', route => {
			const path = new URL(route.request().url()).pathname;
			if (path === '/api/auth/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' });
			return route.fulfill({ contentType: 'application/json', body: JSON.stringify(path === '/api/branding' ? { appName: 'Mailflare', hasCustomIcon: false } : { ok: true }) });
		});
		// A fresh local installation sends every visitor to setup, which offers the language first.
		await page.goto(`${origin}/setup`, { waitUntil: 'domcontentloaded' });
		await page.getByRole('heading', { name: en[SETUP_HEADING], exact: true }).waitFor({ timeout: 30000 });
		await page.getByRole('combobox', { name: en['language.label'] }).click();
		await page.getByRole('option', { name: 'Deutsch', exact: true }).click();
		await page.getByRole('heading', { name: de[SETUP_HEADING], exact: true }).waitFor();
		assert.equal(await page.locator('html').getAttribute('lang'), 'de');
		assert.deepEqual(catalogRequests(requested).map(path => path.split('/').at(-1)), ['en.js', 'de.js'], 'the other language comes from its script');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.getByRole('heading', { name: de[SETUP_HEADING], exact: true }).waitFor();
		assert.equal(catalogRequests(requested).at(-1).split('/').at(-1), 'de.js', 'the choice is kept and the page asks for German alone');
		assert.deepEqual(errors, []);
		await context.close();
	}
	console.log(JSON.stringify({ localeCatalogScripts: true }));
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
