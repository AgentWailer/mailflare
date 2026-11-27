// The reader's sender check with production CSS and a synthetic address book: what it says about a
// forged sender, that it also says it with an empty or unreachable address book and on a message
// opened inside a conversation, and that "this sender is fine" can be taken back.
import { readProductionCss } from './helpers/production-css.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { build } from 'esbuild';

const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dir = mkdtempSync(join(root, 'node_modules', 'mailflare-sender-warning-browser-'));
const write = (name, content) => writeFileSync(join(dir, name), content);
write('mailbox.ts', `const mailbox={id:'box',domainId:'domain',localPart:'steffen',hostname:'lumen.test',displayName:'Steffen Beispiel',signature:'',senderAddresses:['steffen@lumen.test']};export const useSelectedMailbox=()=>({selectedMailbox:mailbox,mailboxes:[mailbox],setSelectedMailbox:()=>{}});`);
write('avatar.tsx', 'export const ContactAvatar=()=>null;');
write('actions.tsx', 'export const ThreadMessageActions=()=>null;');
write('entry.tsx', `import React from 'react';import {createRoot} from 'react-dom/client';
import {SenderWarningBanner} from '@/components/messages/sender-warning-banner';
import {ConversationMessageCard} from '@/components/messages/conversation-thread';
import {LanguageProvider} from '@/components/language-provider';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import de from '../../public/locales/de.json';
const params=new URLSearchParams(location.search);
if(params.has('dark'))document.documentElement.classList.add('dark');
const from=params.get('from')!, replyTo=params.get('replyTo'), html='<p>Bitte überweise heute noch 4.800 Euro. Die Bankdaten stehen <a href="https://lumen-test.example/zahlung">hier: https://lumen.test/zahlung</a>.</p>';
const message={id:'mail',userId:'owner',mailboxId:'box',direction:'inbound',read:true,starred:false,fromAddr:from,replyTo,toAddr:'steffen@lumen.test',subject:'Dringend',snippet:'Bitte überweise',createdAt:'2026-11-20T12:00:00Z',status:'received',threadId:'thread',textBody:'Bitte überweise heute noch 4.800 Euro.',htmlBody:html,bodyLoaded:true,attachments:[]};
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><LanguageProvider initialLocale="de" initialMessages={de}><main style={{maxWidth:900,margin:'0 auto',padding:16}}>
{params.has('thread')?<ConversationMessageCard message={message as never} mailboxId="box" defaultExpanded/>:<>{params.has('twice')&&<SenderWarningBanner fromAddr={from} replyTo={replyTo} html={html}/>}<SenderWarningBanner fromAddr={from} replyTo={replyTo} html={html}/><p data-body>Bitte überweise heute noch 4.800 Euro.</p></>}
</main></LanguageProvider></QueryClientProvider>);`);
const de = JSON.parse(readFileSync(join(root, 'public/locales/de.json'), 'utf8'));
const label = (key, vars = {}) => Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, value), de[key]);

// Whom the owner writes to: a colleague and a friend at a public mail provider.
const book = [
	{ email: 'maya.chen@lumen.test', name: 'Maya Chen', sends: 9, lastSentAt: 5, lastSeenAt: 5, source: 'outbound' },
	{ email: 'friend.name@gmail.com', name: 'Jo Friend', sends: 4, lastSentAt: 3, lastSeenAt: 3, source: 'outbound' },
];

let browser, server;
try {
	await build({ entryPoints: [join(dir, 'entry.tsx')], outfile: join(dir, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic', tsconfig: join(root, 'tsconfig.json'),
		alias: { '@': join(root, 'src'), '@/components/mailbox-provider': join(dir, 'mailbox.ts'), '@/components/contacts/contact-avatar': join(dir, 'avatar.tsx') },
		plugins: [{ name: 'stubs', setup(b) { b.onResolve({ filter: /^\.\/thread-message-actions$/ }, () => ({ path: join(dir, 'actions.tsx') })); } }],
		define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
	const assets = {
		'/': Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),
		'/fixture.js': readFileSync(join(dir, 'fixture.js')), '/fixture.css': readProductionCss(),
	};
	server = createServer((req, res) => { const path = new URL(req.url, 'http://localhost').pathname; res.writeHead(assets[path] ? 200 : 404, { 'Content-Type': path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(assets[path] || 'Not found'); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = 'http://127.0.0.1:' + server.address().port;
	browser = await chromium.launch({ headless: true, executablePath: process.env.MAILFLARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });

	for (const { width, height, touch, dark } of [{ width: 390, height: 844, touch: true }, { width: 390, height: 844, touch: true, dark: true }, { width: 1440, height: 900, touch: false }, { width: 1440, height: 900, touch: false, dark: true }]) {
		const tag = `${width}${dark ? '-dark' : ''}`;
		/** A page showing a message from `from`; `directory` is the address book's answer, or a status when it fails. */
		async function open({ from, replyTo = null, directory = book, thread = false, storage = null, twice = false, user = 'owner' }) {
			const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
			const page = await context.newPage();
			page.setDefaultTimeout(10000);
			const errors = [];
			page.on('pageerror', error => errors.push(error.message));
			if (storage) await page.addInitScript(entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, storage);
			await page.route('**/api/**', route => {
				const path = new URL(route.request().url()).pathname;
				if (path === '/api/compose/recipients') return typeof directory === 'number' ? route.fulfill({ status: directory, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recipients: directory }) });
				if (path === '/api/auth/me') return user ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: user, email: 'steffen@lumen.test', name: 'Steffen Beispiel', role: 'user' } }) }) : route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
				return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
			});
			const query = new URLSearchParams({ from, ...(replyTo ? { replyTo } : {}), ...(dark ? { dark: '1' } : {}), ...(thread ? { thread: '1' } : {}), ...(twice ? { twice: '1' } : {}) });
			await page.goto(origin + '/?' + query);
			return { page, banner: page.locator('[data-sender-warning]'), async close() { assert.deepEqual(errors, [], `${tag}: page errors`); await context.close(); } };
		}
		const whole = async (page, what) => {
			const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
			assert(size.scroll <= size.client, `${tag}: the page overflows horizontally ${what}: ${JSON.stringify(size)}`);
		};

		// 1. A known colleague's name on a strange address, with a link that shows one site and leads to another.
		{
			const t = await open({ from: '"Maya Chen" <maya.chen@lumen-test.example>' });
			await t.banner.waitFor();
			const text = await t.banner.innerText();
			assert(text.includes(label('message.sender.nameOfKnownPerson', { name: 'Maya Chen', known: 'maya.chen@lumen.test', address: 'maya.chen@lumen-test.example' })), text);
			assert(text.includes(label('message.sender.deceptiveLink', { shown: 'lumen.test', target: 'lumen-test.example' })), text);
			assert.equal(await t.banner.getAttribute('role'), 'alert');
			await whole(t.page, 'with the warning');
			const trust = t.banner.getByRole('button', { name: de['message.sender.trust'], exact: true });
			if (touch) assert((await trust.boundingBox()).height >= 44, `${tag}: the button is finger-sized`);
			await t.page.screenshot({ path: `/tmp/mailflare-sender-warning-${tag}.png` });

			// "This sender is fine" says what it did and can be taken back.
			if (touch) await trust.tap(); else await trust.click();
			const note = t.page.locator('[data-sender-trusted]');
			await note.waitFor();
			assert.equal(await t.banner.count(), 0);
			assert((await note.innerText()).includes(label('message.sender.trusted', { address: 'maya.chen@lumen-test.example' })));
			const again = note.getByRole('button', { name: de['message.sender.warnAgain'], exact: true });
			if (touch) assert((await again.boundingBox()).height >= 44, `${tag}: the way back is finger-sized`);
			await whole(t.page, 'with the note');
			await t.page.screenshot({ path: `/tmp/mailflare-sender-trusted-${tag}.png` });
			// It is still there when the message is opened again, with the way back.
			await t.page.reload();
			await note.waitFor();
			assert.equal(await t.banner.count(), 0, `${tag}: a sender marked as fine is not warned about`);
			if (touch) await again.tap(); else await again.click();
			await t.banner.waitFor();
			await t.page.reload();
			await t.banner.waitFor();
			await t.close();
		}
		// 2. An empty address book and one that cannot be read leave the checks that need nobody to compare with.
		for (const directory of [[], 503]) {
			const t = await open({ from: '"chef@firma.test" <x@evil.example>', directory });
			await t.banner.waitFor();
			assert((await t.banner.innerText()).includes(label('message.sender.nameIsOtherAddress', { shown: 'chef@firma.test', address: 'x@evil.example' })), `${tag}: said with ${JSON.stringify(directory)}`);
			await t.close();
		}
		{
			const t = await open({ from: '"Buchhaltung" <rechnung@firma.test>', replyTo: 'firma.buchhaltung.2026@gmail.com', directory: [] });
			await t.banner.waitFor();
			assert((await t.banner.innerText()).includes(label('message.sender.replyElsewhere', { replyTo: 'firma.buchhaltung.2026@gmail.com' })));
			await t.close();
		}
		// 3. A friend's name on another address at the same public provider is not "the same organisation".
		{
			const t = await open({ from: '"Jo Friend" <urgent.help.2026@gmail.com>' });
			await t.banner.waitFor();
			assert((await t.banner.innerText()).includes(label('message.sender.nameOfKnownPerson', { name: 'Jo Friend', known: 'friend.name@gmail.com', address: 'urgent.help.2026@gmail.com' })));
			await t.close();
		}
		// 4. The people the owner writes to, and ordinary strangers, are left alone.
		for (const from of ['"Maya Chen" <maya.chen@lumen.test>', '"Jo Friend" <friend.name@gmail.com>', '"Fahrradladen" <news@fahrradladen.test>']) {
			const t = await open({ from });
			await t.page.locator('[data-body]').waitFor();
			await t.page.waitForTimeout(300);
			assert.equal(await t.banner.count(), 0, `${tag}: no warning for ${from}`);
			assert.equal(await t.page.locator('[data-sender-trusted]').count(), 0);
			await t.close();
		}
		// 5. A message opened inside a conversation is checked like one opened by itself.
		{
			const t = await open({ from: '"Maya Chen" <maya.chen@lumen-test.example>', thread: true });
			await t.banner.waitFor();
			assert((await t.banner.innerText()).includes(label('message.sender.nameOfKnownPerson', { name: 'Maya Chen', known: 'maya.chen@lumen.test', address: 'maya.chen@lumen-test.example' })));
			await whole(t.page, 'in a conversation');
			if (width === 390) await t.page.screenshot({ path: `/tmp/mailflare-sender-warning-thread-${tag}.png` });
			await t.close();
		}
		// 6. A mark made by another person at this browser does not count here, whatever mailboxes they share.
		{
			const t = await open({ from: '"chef@firma.test" <x@evil.example>', storage: { 'mailflare-trusted-senders:user:colleague': '["x@evil.example"]', 'mailflare-trusted-senders': '["x@evil.example"]', 'mailflare-trusted-senders:box': '["x@evil.example"]' } });
			await t.banner.waitFor();
			await t.close();
		}
		// 7. Two checks of one sender on the page (a conversation): answering one answers both, and back again.
		{
			const t = await open({ from: '"chef@firma.test" <x@evil.example>', twice: true });
			await t.page.waitForFunction(() => document.querySelectorAll('[data-sender-warning]').length === 2);
			const trust = t.banner.first().getByRole('button', { name: de['message.sender.trust'], exact: true });
			if (touch) await trust.tap(); else await trust.click();
			await t.page.waitForFunction(() => document.querySelectorAll('[data-sender-trusted]').length === 2 && document.querySelectorAll('[data-sender-warning]').length === 0);
			const again = t.page.locator('[data-sender-trusted]').last().getByRole('button', { name: de['message.sender.warnAgain'], exact: true });
			if (touch) await again.tap(); else await again.click();
			await t.page.waitForFunction(() => document.querySelectorAll('[data-sender-warning]').length === 2 && document.querySelectorAll('[data-sender-trusted]').length === 0);
			await t.close();
		}
		// 8. While it is not known who is reading, the warning is shown and nobody's marks count or can be made.
		{
			const t = await open({ from: '"chef@firma.test" <x@evil.example>', user: null, storage: { 'mailflare-trusted-senders': '["x@evil.example"]' } });
			await t.banner.waitFor();
			assert.equal(await t.banner.getByRole('button').count(), 0, `${tag}: no mark is offered without a reader to keep it for`);
			await t.close();
		}
		console.log(JSON.stringify({ width, height, dark: !!dark, warning: true, emptyAddressBook: true, publicProvider: true, conversation: true, trustTakenBack: true, noOverflow: true }));
	}
} finally {
	await browser?.close();
	await new Promise(resolve => (server ? server.close(resolve) : resolve()));
	rmSync(dir, { recursive: true, force: true });
}
