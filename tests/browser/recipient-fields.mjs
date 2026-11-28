// The real composer with production CSS and synthetic APIs: moving recipients between To, Cc and Bcc
// by mouse, by finger and from the chip menu; suggestions while typing; the questions asked before a
// message goes; undo send. Nothing here sends mail: /api/send is answered by this file.
import { readProductionCss } from './helpers/production-css.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { build } from 'esbuild';

const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dir = mkdtempSync(join(root, 'node_modules', 'mailflare-recipients-browser-'));
const write = (name, content) => writeFileSync(join(dir, name), content);
write('navigation.ts', `export const useRouter=()=>({push:()=>{},replace:()=>{}});export const usePathname=()=>'/inbox';`);
write('mailbox.ts', `const mailbox={id:'box',domainId:'domain',localPart:'owner',hostname:'lumen.test',displayName:'Avery Owner',signature:'',senderAddresses:['owner@lumen.test']};export const useSelectedMailbox=()=>({selectedMailbox:mailbox,mailboxes:[mailbox],setSelectedMailbox:()=>{}});`);
write('entry.tsx', `import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {ComposeProvider,useCompose} from '@/components/compose/compose-context';
import {FloatingComposer} from '@/components/compose/floating-composer';
import {parseMailto} from '@/components/compose/mailto-utils';
import {LanguageProvider} from '@/components/language-provider';
import de from '../../public/locales/de.json';
const params=new URLSearchParams(location.search);
if(params.has('dark'))document.documentElement.classList.add('dark');
function Open(){const compose=useCompose();useEffect(()=>{const link=parseMailto(params.get('mailto'));if(link)compose.openComposerWith(link);else if(params.has('draft'))compose.openDraftComposer('draft');else compose.openComposer();},[]);return null;}
createRoot(document.getElementById('root')!).render(<LanguageProvider initialLocale="de" initialMessages={de}><ComposeProvider><Open/><FloatingComposer/></ComposeProvider></LanguageProvider>);`);
const de = JSON.parse(readFileSync(join(root, 'public/locales/de.json'), 'utf8'));
const label = (key, vars = {}) => Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, value), de[key]);

// Who the owner writes to, as /api/compose/recipients ranks them.
const directory = [
	{ email: 'maya.chen@lumen.test', name: 'Maya Chen', sends: 9, lastSentAt: 5, lastSeenAt: 5, source: 'outbound' },
	{ email: 'max@partner.test', name: 'Max Partner', sends: 5, lastSentAt: 4, lastSeenAt: 4, source: 'outbound' },
	{ email: 'lin@harborworks.test', name: 'Lin Okoro', sends: 4, lastSentAt: 3, lastSeenAt: 3, source: 'manual' },
	{ email: 'mayflower@tours.test', name: 'Mayflower Tours', sends: 0, lastSentAt: null, lastSeenAt: 2, source: 'inbound' },
];
const draft = { id: 'draft', mailboxId: 'box', fromAddr: 'owner@lumen.test', toAddr: '"Maya Chen" <maya.chen@lumen.test>, max@partner.test, lin@harborworks.test', ccAddr: null, bccAddr: null, subject: 'Termin am Dienstag', htmlBody: '<p>Hallo zusammen, passt Dienstag?</p>', textBody: 'Hallo zusammen, passt Dienstag?', attachments: [] };
const restored = { ...draft, id: 'sent-1', toAddr: '"Maya Chen" <maya.chen@lumen.test>', subject: 'Kurze Frage', htmlBody: '<p>Hallo Maya</p>', textBody: 'Hallo Maya' };
const field = (body, name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1];

let browser, server;
try {
	await build({ entryPoints: [join(dir, 'entry.tsx')], outfile: join(dir, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic', tsconfig: join(root, 'tsconfig.json'),
		alias: { '@': join(root, 'src'), '@/components/mailbox-provider': join(dir, 'mailbox.ts'), 'next/navigation': join(dir, 'navigation.ts') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
	const assets = {
		'/': Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0;background:#f6f8fc"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),
		'/fixture.js': readFileSync(join(dir, 'fixture.js')), '/fixture.css': readProductionCss(),
	};
	server = createServer((req, res) => { const path = new URL(req.url, 'http://localhost').pathname; res.writeHead(assets[path] ? 200 : 404, { 'Content-Type': path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(assets[path] || 'Not found'); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = 'http://127.0.0.1:' + server.address().port;
	browser = await chromium.launch({ headless: true, executablePath: process.env.MAILFLARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });

	const configs = [{ width: 390, height: 844, touch: true }, { width: 320, height: 700, touch: true }, { width: 820, height: 1180, touch: true }, { width: 1440, height: 900, touch: false }, { width: 1440, height: 900, touch: false, dark: true }]
		.filter(config => !process.env.RECIPIENT_VIEWPORT_WIDTH || config.width === Number(process.env.RECIPIENT_VIEWPORT_WIDTH));
	for (const config of configs) {
		const { width, height, touch, dark } = config;
		const tag = `${width}${dark ? '-dark' : ''}`;

		/** A fresh page with its own record of what the composer asked the server. */
		async function open({ withDraft = false, undoSeconds = 0, cancelStatus = 200, mailto = null, undoRemainingMs = null, reply = false, sendStatus = 200, sendBody = null, directoryDelay = 0, directoryStatus = 200 } = {}) {
			const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, permissions: ['clipboard-read', 'clipboard-write'] });
			const page = await context.newPage();
			page.setDefaultTimeout(10000);
			const calls = { sends: [], saves: [], cancels: [], cancelled: [], errors: [] };
			page.on('pageerror', error => calls.errors.push(error.message));
			if (undoSeconds) await page.addInitScript(seconds => localStorage.setItem('mailflare-undo-send-seconds', String(seconds)), undoSeconds);
			await page.route('**/api/**', async route => {
				const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
				const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
				if (path === '/api/send') {
					const body = request.postData() ?? '';
					calls.sends.push({ to: field(body, 'to'), cc: field(body, 'cc'), bcc: field(body, 'bcc'), subject: field(body, 'subject'), undoSeconds: field(body, 'undoSeconds') });
					if (sendStatus !== 200) return json({ error: sendStatus === 401 ? 'Unauthorized' : 'Mailbox not found' }, sendStatus);
					if (sendBody !== null) return route.fulfill({ status: 200, contentType: 'application/json', body: sendBody });
					const messageId = 'sent-' + calls.sends.length;
					return json(field(body, 'undoSeconds') ? { messageId, scheduled: true, undoUntil: new Date(Date.now() + 10000).toISOString(), ...(undoRemainingMs === null ? {} : { undoRemainingMs }) } : { messageId });
				}
				if (/^\/api\/messages\/sent-\d+\/cancel-schedule$/.test(path)) { calls.cancels.push(method); calls.cancelled.push(path.split('/')[3]); return json(cancelStatus === 200 ? { ok: true } : { error: 'This message is already being sent' }, cancelStatus); }
				if (path === '/api/compose/recipients') {
					if (directoryDelay) await new Promise(resolve => setTimeout(resolve, directoryDelay));
					return directoryStatus === 200 ? json({ recipients: directory }) : json({ error: 'unavailable' }, directoryStatus);
				}
				if (path === '/api/attachment-policy') return json({ maxMb: 25, cloudThresholdBytes: 3000000 });
				if (path === '/api/templates') return json({ templates: [] });
				if (/^\/api\/drafts\/sent-\d+$/.test(path) && method === 'GET') return json({ draft: { ...restored, id: path.split('/')[3] } });
				if (path.startsWith('/api/drafts') && (method === 'PATCH' || method === 'POST')) { calls.saves.push(request.postDataJSON()); return json({ draft: { id: 'draft' } }); }
				if (path.startsWith('/api/drafts') && method === 'DELETE') return json({ ok: true });
				return json({ draft: reply ? { ...draft, subject: 'Re: Rechnung im Anhang', inReplyTo: '<original@lumen.test>', threadId: 'thread-1' } : draft });
			});
			await page.goto(origin + '/?' + [withDraft && 'draft=1', dark && 'dark=1', mailto && 'mailto=' + encodeURIComponent(mailto)].filter(Boolean).join('&'));
			const form = page.locator('form');
			const editor = form.getByRole('textbox', { name: de['editor.messageBody'], exact: true });
			await editor.waitFor();
			if (withDraft) await editor.getByText('passt Dienstag').waitFor();
			const row = name => form.locator(`[data-recipient-field="${name}"]`);
			return {
				context, page, form, editor, calls, row,
				chips: async name => (await row(name).count()) ? row(name).locator('[data-recipient-chip]').evaluateAll(nodes => nodes.map(node => node.dataset.entry)) : null,
				chip: (name, text) => row(name).locator('[data-recipient-chip]', { hasText: text }),
				input: name => form.getByRole('combobox', { name: de[`compose.${name}`], exact: true }),
				send: form.getByRole('button', { name: de['compose.send'], exact: true }),
				async noOverflow(what) {
					const size = await form.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
					assert(size.scroll <= size.client, `${tag}: composer overflows horizontally ${what}: ${JSON.stringify(size)}`);
				},
				async inViewport(locator, what) {
					const box = await locator.boundingBox();
					assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `${tag}: ${what} is inside the screen: ${JSON.stringify(box)}`);
					return box;
				},
				async close() { assert.deepEqual(calls.errors, [], `${tag}: page errors`); await context.close(); },
			};
		}
		const centre = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }; };
		const MAYA = '"Maya Chen" <maya.chen@lumen.test>';

		// 1. Dragging a recipient to another line: with the mouse, and with a finger that rests on the chip first.
		{
			const t = await open({ withDraft: true });
			assert.deepEqual(await t.chips('to'), [MAYA, 'max@partner.test', 'lin@harborworks.test']);
			assert.equal(await t.chips('cc'), null, 'Cc starts folded away');
			const ghost = t.page.locator('[data-recipient-drag-ghost]'), menu = t.page.getByRole('menu');
			const from = await centre(t.chip('to', 'max@partner.test'));
			if (touch) {
				// A chip is pressed with a thumb here: its name and its remove button are each a full target.
				const targets = await t.chip('to', 'max@partner.test').locator('button').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { remove: node.hasAttribute('data-recipient-remove'), width: r.width, height: r.height }; }));
				assert.equal(targets.length, 2);
				for (const target of targets) assert(target.height >= 44 && (!target.remove || target.width >= 44), `${tag}: chip targets are finger-sized: ${JSON.stringify(targets)}`);
				const reveal = await t.form.locator('[data-recipient-reveal]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { text: node.textContent, width: r.width, height: r.height }; }));
				assert.equal(reveal.length, 2);
				for (const target of reveal) assert(target.width >= 44 && target.height >= 44, `${tag}: Cc and Bcc are finger-sized: ${JSON.stringify(reveal)}`);
				const cdp = await t.context.newCDPSession(t.page);
				const finger = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y), id: 1 }] });

				// A finger that moves at once is scrolling, not dragging: nothing lifts off and nothing moves.
				await finger('touchStart', from.x, from.y);
				for (let step = 1; step <= 5; step++) await finger('touchMove', from.x, from.y + step * 12);
				await t.page.waitForTimeout(400);
				assert.equal(await ghost.count(), 0, `${tag}: a swipe does not lift a chip`);
				await finger('touchEnd');
				assert.deepEqual(await t.chips('to'), [MAYA, 'max@partner.test', 'lin@harborworks.test']);

				// Press and hold lifts the chip; the folded lines open as places to drop it.
				await finger('touchStart', from.x, from.y);
				await ghost.waitFor();
				await t.row('bcc').waitFor();
				assert.equal(await t.row('bcc').getByPlaceholder(de['recipient.dropHere'], { exact: true }).count(), 1);
				const target = await centre(t.row('bcc'));
				for (let step = 1; step <= 8; step++) await finger('touchMove', from.x + (target.x - from.x) * step / 8, from.y + (target.y - from.y) * step / 8);
				await t.row('bcc').locator('[data-recipient-drop-marker]').waitFor();
				const lifted = await ghost.boundingBox();
				assert(lifted.y + lifted.height <= target.y, `${tag}: the lifted chip shows above the finger, not under it`);
				await t.page.screenshot({ path: `/tmp/mailflare-recipient-drag-${tag}.png` });
				await t.noOverflow('while dragging');
				await finger('touchEnd');
			} else {
				await t.page.mouse.move(from.x, from.y);
				await t.page.mouse.down();
				await t.page.mouse.move(from.x + 3, from.y + 1);
				assert.equal(await ghost.count(), 0, 'a press that barely moves is still a click');
				await t.page.mouse.move(from.x + 14, from.y + 6, { steps: 3 });
				await ghost.waitFor();
				await t.row('bcc').waitFor();
				const target = await centre(t.row('bcc'));
				await t.page.mouse.move(target.x, target.y, { steps: 8 });
				await t.row('bcc').locator('[data-recipient-drop-marker]').waitFor();
				await t.page.screenshot({ path: `/tmp/mailflare-recipient-drag-${tag}.png` });
				await t.noOverflow('while dragging');
				await t.page.mouse.up();
			}
			await ghost.waitFor({ state: 'detached' });
			assert.deepEqual(await t.chips('to'), [MAYA, 'lin@harborworks.test'], `${tag}: the chip left To`);
			assert.deepEqual(await t.chips('bcc'), ['max@partner.test'], `${tag}: the chip arrived in Bcc`);
			assert.equal(await t.chips('cc'), null, 'the line that got nothing folds away again');
			await t.page.waitForTimeout(150);
			assert.equal(await menu.count(), 0, `${tag}: dropping a chip does not open its menu`);
			assert.match(await t.form.locator('[data-recipient-fields] [role="status"]').textContent(), /max@partner\.test/, 'the move is announced to screen readers');
			await t.page.waitForTimeout(1200);
			const saved = t.calls.saves.at(-1);
			assert.equal(saved.bcc, 'max@partner.test', `${tag}: the move is saved with the draft`);
			assert.equal(saved.to, `${MAYA}, lin@harborworks.test`);

			if (!touch) {
				// Dropping between two chips puts it there; dropping outside the lines changes nothing; Escape gives up.
				const maya = await centre(t.chip('to', 'Maya Chen')), back = await centre(t.chip('bcc', 'max@partner.test'));
				await t.page.mouse.move(back.x, back.y); await t.page.mouse.down();
				await t.page.mouse.move(maya.box.x + maya.box.width - 4, maya.y, { steps: 8 });
				await t.row('to').locator('[data-recipient-drop-marker]').waitFor();
				await t.page.mouse.up();
				assert.deepEqual(await t.chips('to'), [MAYA, 'max@partner.test', 'lin@harborworks.test'], 'dropped after the first chip');
				assert.deepEqual(await t.chips('bcc'), [], 'Bcc stays open once it was used');
				const lin = await centre(t.chip('to', 'lin@harborworks.test')), body = await centre(t.editor);
				await t.page.mouse.move(lin.x, lin.y); await t.page.mouse.down(); await t.page.mouse.move(body.x, body.y, { steps: 6 }); await ghost.waitFor(); await t.page.mouse.up();
				assert.deepEqual(await t.chips('to'), [MAYA, 'max@partner.test', 'lin@harborworks.test'], 'a drop outside the lines changes nothing');
				await t.page.mouse.move(lin.x, lin.y); await t.page.mouse.down(); await t.page.mouse.move(lin.x + 30, lin.y + 40, { steps: 4 }); await ghost.waitFor();
				await t.page.keyboard.press('Escape'); await ghost.waitFor({ state: 'detached' }); await t.page.mouse.up();
				assert.deepEqual(await t.chips('to'), [MAYA, 'max@partner.test', 'lin@harborworks.test'], 'Escape gives the drag up');
				assert.equal(await t.form.count(), 1, 'and leaves the composer open');
			}
			await t.close();
		}

		// 2. The chip menu does the same without dragging, by tap, click or keyboard.
		{
			const t = await open({ withDraft: true });
			const trigger = t.chip('to', 'Maya Chen').locator('button').first();
			if (touch) await trigger.tap(); else await trigger.click();
			const menu = t.page.getByRole('menu');
			await menu.waitFor();
			await t.inViewport(menu, 'the chip menu');
			assert.equal(await menu.getByText('maya.chen@lumen.test', { exact: true }).count(), 1, 'the menu says which address it is about');
			const toCc = menu.getByRole('menuitem', { name: label('recipient.moveTo', { field: de['compose.cc'] }), exact: true });
			if (touch) assert((await toCc.boundingBox()).height >= 44, `${tag}: menu entries are finger-sized`);
			if (width === 390 || dark) await t.page.screenshot({ path: `/tmp/mailflare-recipient-menu-${tag}.png` });
			await toCc.click();
			assert.deepEqual(await t.chips('cc'), [MAYA]);
			assert.deepEqual(await t.chips('to'), ['max@partner.test', 'lin@harborworks.test']);

			// Keyboard only: open the menu on the chip, move it on to Bcc.
			await t.chip('cc', 'Maya Chen').locator('button').first().focus();
			await t.page.keyboard.press('Enter');
			await menu.waitFor();
			await menu.getByRole('menuitem', { name: label('recipient.moveTo', { field: de['compose.bcc'] }), exact: true }).focus();
			await t.page.keyboard.press('Enter');
			assert.deepEqual(await t.chips('bcc'), [MAYA]);
			assert.deepEqual(await t.chips('cc'), []);

			// Edit pulls the address back into the line; Remove takes it off; the x still works.
			await t.chip('to', 'max@partner.test').locator('button').first().click();
			await menu.getByRole('menuitem', { name: de['recipient.edit'], exact: true }).click();
			await t.page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
			assert.equal(await t.input('to').inputValue(), 'max@partner.test');
			await t.input('to').fill('maxine@partner.test');
			await t.page.keyboard.press('Enter');
			assert.deepEqual(await t.chips('to'), ['lin@harborworks.test', 'maxine@partner.test']);
			await t.chip('to', 'maxine@partner.test').locator('button').first().click();
			await menu.getByRole('menuitem', { name: de['recipient.removeItem'], exact: true }).click();
			await t.chip('to', 'lin@harborworks.test').getByRole('button', { name: label('recipient.remove', { address: 'lin@harborworks.test' }), exact: true }).click();
			assert.deepEqual(await t.chips('to'), []);
			await t.noOverflow('after moving chips');
			await t.close();
		}

		// 3. Suggestions while typing.
		{
			const t = await open();
			const to = t.input('to'), list = t.page.getByRole('listbox', { name: de['recipient.suggestions'], exact: true }), options = list.getByRole('option');
			await to.click();
			assert.equal(await list.count(), 0, 'nothing is suggested before anything is typed');
			await to.pressSequentially('ma');
			await list.waitFor();
			assert.deepEqual(await options.evaluateAll(nodes => nodes.map(node => node.firstElementChild.textContent)), ['Maya Chen', 'Max Partner', 'Mayflower Tours'], `${tag}: most written-to first`);
			const listBox = await t.inViewport(list, 'the suggestion list'), inputBox = await to.boundingBox();
			assert(listBox.y >= inputBox.y + inputBox.height - 1, `${tag}: the list opens under the line and does not cover what is typed`);
			if (touch) assert((await options.first().boundingBox()).height >= 44, `${tag}: suggestions are finger-sized`);
			assert.equal(await to.getAttribute('aria-expanded'), 'true');
			assert.equal(await options.first().getAttribute('aria-selected'), 'true');
			if (width === 390 || dark) await t.page.screenshot({ path: `/tmp/mailflare-recipient-suggestions-${tag}.png` });

			{
				// The address under a highlighted name is readable on the highlight, in dark mode too.
				const ratio = await options.first().evaluate(option => {
					// Whatever notation the browser reports (oklch, lab), a canvas says the colour in sRGB.
					const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
					const parse = value => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3); };
					const luminance = ([r, g, b]) => [r, g, b].map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
					const text = luminance(parse(getComputedStyle(option.lastElementChild).color)), ground = luminance(parse(getComputedStyle(option).backgroundColor));
					return (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05);
				});
				assert(ratio >= 4.5, `${tag}: the highlighted suggestion's address has contrast ${ratio.toFixed(2)}`);
			}
			// Shift+Tab leaves the line for the control before it; it never picks the highlighted person.
			await t.page.keyboard.press('Shift+Tab');
			assert.equal((await t.chips('to')).some(entry => entry.includes('maya.chen@lumen.test')), false, `${tag}: Shift+Tab did not pick a suggestion`);
			assert.equal(await to.evaluate(el => el === document.activeElement), false, `${tag}: Shift+Tab leaves the line`);
			await t.row('to').locator('[data-recipient-remove]').first().click();
			await to.click();
			await to.pressSequentially('ma');
			await list.waitFor();

			await t.page.keyboard.press('ArrowDown');
			assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
			await t.page.keyboard.press('Enter');
			assert.deepEqual(await t.chips('to'), ['"Max Partner" <max@partner.test>'], 'the highlighted suggestion is taken with its name');
			assert.equal(t.calls.sends.length, 0, 'Enter in the list never submits the message');

			await to.pressSequentially('chen');
			await options.first().waitFor();
			if (touch) await options.first().tap(); else await options.first().click();
			assert.deepEqual(await t.chips('to'), ['"Max Partner" <max@partner.test>', MAYA], 'a tapped suggestion is taken; the half-typed text is not left behind as a chip');
			assert(await to.evaluate(el => el === document.activeElement), `${tag}: the caret stays in the line for the next name`);

			await to.pressSequentially('ma');
			await list.waitFor();
			assert.deepEqual(await options.evaluateAll(nodes => nodes.map(node => node.firstElementChild.textContent)), ['Mayflower Tours'], 'people already on the message are not offered again');
			await t.page.keyboard.press('Escape');
			await list.waitFor({ state: 'detached' });
			assert.equal(await to.inputValue(), 'ma', 'Escape closes the list and keeps the text');
			assert.equal(await t.form.count(), 1);
			await to.fill('');

			// A complete address is what the writer means: Enter keeps it and does not swap in a suggestion.
			await to.pressSequentially('lin@harborworks.test');
			await list.waitFor();
			assert.equal(await list.locator('[aria-selected="true"]').count(), 0);
			await t.page.keyboard.press('Enter');
			assert.deepEqual((await t.chips('to')).at(-1), 'lin@harborworks.test');

			// The Cc toggle works while the caret is in To, where leaving To reflows the row under the pointer.
			await t.form.getByRole('button', { name: de['compose.cc'], exact: true }).click();
			await t.page.waitForFunction(id => document.activeElement?.id === id, 'popup-cc');
			await t.page.keyboard.type('tours');
			await options.first().waitFor();
			await t.page.keyboard.press('Tab');
			assert.deepEqual(await t.chips('cc'), ['"Mayflower Tours" <mayflower@tours.test>']);
			await t.noOverflow('with suggestions');
			await t.close();
		}

		// 4. Questions before a message goes.
		{
			const t = await open();
			const warning = t.page.locator('[data-send-warning]');
			await t.input('to').fill('lin@harborwork.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Unterlagen');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Lin, anbei die Unterlagen.');
			await t.send.click();
			await warning.waitFor();
			assert.equal(t.calls.sends.length, 0, `${tag}: nothing goes while the question is open`);
			const text = await warning.innerText();
			assert(text.includes(label('compose.warn.lookalike', { address: 'lin@harborwork.test', like: 'harborworks.test' })), text);
			assert(text.includes(de['compose.warn.missingAttachment']), text);
			await t.inViewport(warning, 'the question');
			{
				// Every answer can be read and pressed: none is cut off by the dialog, in the real German wording.
				const frame = await warning.boundingBox(), buttons = warning.getByRole('button');
				const boxes = await buttons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { text: node.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom, clipped: node.scrollWidth > node.clientWidth }; }));
				for (const box of boxes) assert(box.x >= frame.x && box.right <= frame.x + frame.width + 0.5 && box.bottom <= frame.y + frame.height + 0.5 && !box.clipped, `${tag}: "${box.text}" is whole inside the question: ${JSON.stringify({ box, frame })}`);
				const back = boxes.find(box => box.text === de['compose.warn.back']), anyway = boxes.find(box => box.text === de['compose.warn.sendAnyway']);
				if (width < 640) assert(back.y < anyway.y, `${tag}: on a phone the way back comes first, sending past the warning last`);
				const [backFilled, anywayFilled] = await Promise.all(['[data-send-warning-back]', '[data-send-warning-send]'].map(selector => warning.locator(selector).evaluate(node => getComputedStyle(node).backgroundColor)));
				assert.notEqual(backFilled, anywayFilled, `${tag}: the way back is the filled button, not sending anyway`);
			}
			if (width === 390 || dark) await t.page.screenshot({ path: `/tmp/mailflare-send-warning-${tag}.png` });
			assert.equal(await t.page.evaluate(() => document.activeElement?.textContent), de['compose.warn.back'], 'the way back is focused');
			await t.page.keyboard.press('Enter');
			await warning.waitFor({ state: 'detached' });
			assert.equal(t.calls.sends.length, 0, `${tag}: Enter never sends from the question`);
			assert.deepEqual(await t.chips('to'), ['lin@harborwork.test'], 'the message is as it was');

			await t.send.click();
			await warning.getByRole('button', { name: de['compose.warn.sendAnyway'], exact: true }).click();
			await t.page.waitForFunction(() => !document.querySelector('[data-send-warning]'));
			await t.page.getByText(de['compose.sent'], { exact: true }).waitFor();
			assert.deepEqual(t.calls.sends.map(send => send.to), ['lin@harborwork.test'], 'sent once, after the answer');
			assert.equal(t.calls.sends[0].undoSeconds, undefined, 'no undo window unless it is switched on');
			await t.close();
		}
		{
			// Five people at other organisations in To: offered to move them to Bcc, where they cannot see each other.
			const t = await open();
			const outsiders = ['a@one.test', 'b@one.test', 'c@two.test', 'd@three.test', 'e@three.test'];
			await t.input('to').fill('maya.chen@lumen.test, ' + outsiders.join(', ') + ',');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Einladung');
			await t.editor.click();
			await t.page.keyboard.type('Wir laden herzlich ein.');
			await t.noOverflow('with six recipients');
			await t.send.click();
			const warning = t.page.locator('[data-send-warning]');
			await warning.waitFor();
			assert((await warning.innerText()).includes(label('compose.warn.outsiders', { people: '5', domains: '3' })));
			await warning.getByRole('button', { name: de['compose.warn.moveToBcc'], exact: true }).click();
			await t.page.getByText(de['compose.sent'], { exact: true }).waitFor();
			assert.deepEqual(t.calls.sends, [{ to: 'maya.chen@lumen.test', cc: undefined, bcc: outsiders.join(', '), subject: 'Einladung', undoSeconds: undefined }], `${tag}: the colleague stays in To, the outsiders go out in Bcc`);
			await t.close();
		}
		{
			// Outsiders in To and a promised attachment that is missing: moving to Bcc answers only its own question.
			const t = await open();
			const outsiders = ['a@one.test', 'b@one.test', 'c@two.test', 'd@three.test', 'e@three.test'];
			await t.input('to').fill('maya.chen@lumen.test, ' + outsiders.join(', ') + ',');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Einladung');
			await t.editor.click();
			await t.page.keyboard.type('Die Einladung finden Sie im Anhang.');
			await t.send.click();
			const warning = t.page.locator('[data-send-warning]');
			await warning.waitFor();
			{
				// Three answers in German are the widest row there is; none may be cut off.
				const frame = await warning.boundingBox();
				const boxes = await warning.getByRole('button').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { text: node.textContent, x: r.x, right: r.right }; }));
				assert.equal(boxes.length, 3);
				for (const box of boxes) assert(box.x >= frame.x && box.right <= frame.x + frame.width + 0.5, `${tag}: "${box.text}" is whole inside the question: ${JSON.stringify({ box, frame })}`);
				if (width === 1440) { await t.page.waitForTimeout(350); await t.page.screenshot({ path: `/tmp/mailflare-send-warning-three-${tag}.png` }); }
			}
			assert.equal(await warning.getByRole('button', { name: de['compose.warn.moveToBcc'], exact: true }).count(), 0, 'it does not promise to send while another question is open');
			await warning.getByRole('button', { name: de['compose.warn.moveToBccOnly'], exact: true }).click();
			await t.page.waitForFunction(text => document.querySelector('[data-send-warning]') && !document.querySelector('[data-send-warning]').textContent.includes(text), label('compose.warn.outsiders', { people: '5', domains: '3' }));
			assert.equal(t.calls.sends.length, 0, `${tag}: nothing went past the missing attachment`);
			assert.equal(await t.page.evaluate(() => document.activeElement?.textContent), de['compose.warn.back'], `${tag}: with its button gone, focus is on the way back, not lost`);
			assert((await warning.innerText()).includes(de['compose.warn.missingAttachment']));
			assert.deepEqual(await t.chips('bcc'), outsiders, 'the outsiders are in Bcc');
			assert.deepEqual(await t.chips('to'), ['maya.chen@lumen.test']);
			await warning.getByRole('button', { name: de['compose.warn.sendAnyway'], exact: true }).click();
			await t.page.getByText(de['compose.sent'], { exact: true }).waitFor();
			assert.deepEqual(t.calls.sends.map(send => send.bcc), [outsiders.join(', ')], 'sent once, after the second answer');
			await t.close();
		}
		{
			// A reply whose subject mentions an attachment is the other side's wording, not a promise of the writer.
			const t = await open({ withDraft: true, reply: true });
			assert.equal(await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).inputValue(), 'Re: Rechnung im Anhang');
			await t.send.click();
			await t.page.getByText(de['compose.sent'], { exact: true }).waitFor();
			assert.equal(await t.page.locator('[data-send-warning]').count(), 0, `${tag}: a reply is not asked about the subject it answers`);
			await t.close();
		}
		{
			// In a new message the subject is the writer's own, and a promised attachment is asked about.
			const t = await open();
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Rechnung im Anhang');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			await t.page.locator('[data-send-warning]').getByText(de['compose.warn.missingAttachment'], { exact: true }).waitFor();
			assert.equal(t.calls.sends.length, 0);
			await t.close();
		}
		{
			// An ordinary message to someone the owner writes to is not asked about.
			const t = await open();
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			await t.page.getByText(de['compose.sent'], { exact: true }).waitFor();
			assert.equal(await t.page.locator('[data-send-warning]').count(), 0);
			assert.equal(t.calls.sends.length, 1);
			await t.close();
		}

		// 5. Undo send: the message is held, Undo takes it back and reopens it; too late says so.
		for (const cancelStatus of [200, 409]) {
			const t = await open({ undoSeconds: 10, cancelStatus });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			const toast = t.page.locator('[data-undo-send]');
			await toast.waitFor();
			assert.equal(t.calls.sends[0].undoSeconds, '10', `${tag}: the server is asked to hold the message`);
			assert.equal(await t.page.getByText(de['compose.sent'], { exact: true }).count(), 0, 'not reported as sent while it can be taken back');
			const undo = toast.getByRole('button', { name: de['compose.undo.action'], exact: true });
			const box = await t.inViewport(undo, 'Undo');
			if (touch) assert(box.height >= 44, `${tag}: Undo is finger-sized`);
			assert.equal(await undo.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, `${tag}: Undo is not covered by the composer`);
			// The offer must not sit on the composer's own controls: the next message is written while it shows.
			const toastBox = await toast.boundingBox();
			for (const control of [t.send, t.form.getByRole('button', { name: de['compose.attachFiles'], exact: true }), t.form.getByRole('button', { name: de['compose.deleteDraft'], exact: true })]) {
				const other = await control.boundingBox();
				const apart = toastBox.x + toastBox.width <= other.x || other.x + other.width <= toastBox.x || toastBox.y + toastBox.height <= other.y || other.y + other.height <= toastBox.y;
				assert(apart, `${tag}: the undo offer leaves the composer's buttons free: ${JSON.stringify({ toastBox, other })}`);
			}
			if (cancelStatus === 200) await t.page.screenshot({ path: `/tmp/mailflare-undo-send-${tag}.png` });
			if (touch) await undo.tap(); else await undo.click();
			if (cancelStatus === 200) {
				await t.page.getByText(de['compose.undo.restored'], { exact: true }).waitFor();
				await t.editor.getByText('Hallo Maya').waitFor();
				assert.deepEqual(await t.chips('to'), [MAYA], `${tag}: the message is open again with its recipient`);
				assert.equal(await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).inputValue(), 'Kurze Frage');
			} else {
				await t.page.getByRole('alert').filter({ hasText: de['compose.undo.tooLate'] }).waitFor();
				assert.deepEqual(await t.chips('to'), [], 'a message that already went is not reopened');
			}
			assert.deepEqual(t.calls.cancels, ['POST']);
			assert.equal(t.calls.sends.length, 1);
			await t.close();
		}
		// The offer lasts as long as the server holds the message, however the page re-renders meanwhile,
		// and a window that is already used up is not offered at all.
		{
			const t = await open({ undoSeconds: 10, undoRemainingMs: 2500 });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			const toast = t.page.locator('[data-undo-send]');
			await toast.waitFor();
			const shown = Date.now();
			// Writing the next message re-renders the composer and its provider again and again.
			await t.input('to').fill('max@partner.test');
			await t.editor.click();
			await t.page.keyboard.type('Noch etwas');
			await toast.waitFor({ state: 'detached' });
			const lasted = Date.now() - shown;
			assert(lasted < 2600, `${tag}: the offer ends before the server delivers (2.5 s), it lasted ${lasted} ms`);
			assert.equal(t.calls.cancels.length, 0);
			await t.close();
		}
		{
			const t = await open({ undoSeconds: 10, undoRemainingMs: 300 });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			await t.page.getByText(de['compose.sent'], { exact: true }).waitFor();
			assert.equal(await t.page.locator('[data-undo-send]').count(), 0, `${tag}: no Undo is offered that could not be pressed in time`);
			await t.close();
		}
		// Undo while the next message is being written: that one stays, the restored one waits under Drafts.
		{
			const t = await open({ undoSeconds: 10 });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			const toast = t.page.locator('[data-undo-send]');
			await toast.waitFor();
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Die nächste Nachricht');
			await t.editor.click();
			await t.page.keyboard.type('Neuer Text');
			// Ctrl+Z in a text field stays the field's own undo.
			await t.page.keyboard.press('Control+z');
			assert.equal(t.calls.cancels.length, 0, `${tag}: undo in the text does not take the sent message back`);
			const undo = toast.getByRole('button', { name: de['compose.undo.action'], exact: true });
			if (touch) await undo.tap(); else await undo.click();
			await t.page.getByText(de['compose.undo.inDrafts'], { exact: true }).waitFor();
			assert.deepEqual(t.calls.cancels, ['POST']);
			assert.equal(await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).inputValue(), 'Die nächste Nachricht', `${tag}: the message being written is not replaced`);
			await t.close();
		}
		// Without a pointer: Ctrl+Z outside a text field takes the message back.
		if (!touch) {
			const t = await open({ undoSeconds: 10 });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			const toast = t.page.locator('[data-undo-send]');
			await toast.waitFor();
			// ⌘Z on an Apple keyboard, Strg+Z elsewhere: the page says the one this machine has.
			const keys = de[await t.page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)) ? 'compose.undo.keysApple' : 'compose.undo.keys'];
			assert.equal(await toast.locator('[data-undo-keys]').innerText(), keys, `${tag}: the key that takes it back is shown beside the button`);
			assert((await toast.evaluate(node => node.textContent)).includes(label('compose.undo.hint', { seconds: '9', keys })), 'how long the offer lasts and its key are read out with it: ' + await toast.evaluate(node => node.textContent));
			await t.page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
			await t.page.keyboard.press('Control+z');
			await t.page.getByText(de['compose.undo.restored'], { exact: true }).waitFor();
			assert.deepEqual(t.calls.cancels, ['POST']);
			await t.close();
		}
		// Two messages wait at once: each offer says whom it goes to, and Ctrl+Z takes back the newest that
		// can still be taken back, then the one before it.
		if (!touch) {
			const t = await open({ undoSeconds: 30 });
			for (const [index, [address, subject]] of [['maya.chen@lumen.test', 'Erste'], ['max@partner.test', 'Zweite']].entries()) {
				await t.input('to').fill(address);
				await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill(subject);
				await t.editor.click();
				await t.page.keyboard.type('Hallo');
				await t.send.click();
				await t.page.waitForFunction(count => document.querySelectorAll('[data-undo-send]').length === count, index + 1);
			}
			const offers = t.page.locator('[data-undo-send]');
			assert.deepEqual(await offers.evaluateAll(nodes => nodes.map(node => node.firstElementChild.firstChild.textContent)), [label('compose.undo.pendingAbout', { subject: 'Erste', recipient: 'maya.chen@lumen.test' }), label('compose.undo.pendingAbout', { subject: 'Zweite', recipient: 'max@partner.test' })], `${tag}: two offers can be told apart by subject and recipient`);
			assert.deepEqual(await offers.evaluateAll(nodes => nodes.map(node => !!node.querySelector('[data-undo-keys]'))), [false, true], `${tag}: the key is shown on the offer it would take back`);
			await t.page.screenshot({ path: `/tmp/mailflare-undo-send-two-${tag}.png` });
			await t.page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
			await t.page.keyboard.press('Control+z');
			await t.page.getByText(de['compose.undo.restored'], { exact: true }).waitFor();
			assert.deepEqual(t.calls.cancelled, ['sent-2'], 'the newest first');
			await t.page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
			await t.page.keyboard.press('Control+z');
			await t.page.getByText(de['compose.undo.inDrafts'], { exact: true }).waitFor();
			assert.deepEqual(t.calls.cancelled, ['sent-2', 'sent-1'], `${tag}: the shortcut then serves the older message`);
			await t.close();
		}
		// An expired sign-in is said in the composer; the message and its recipients stay.
		{
			const t = await open({ sendStatus: 401 });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			const address = t.page.url();
			await t.send.click();
			await t.page.getByRole('alert').filter({ hasText: de['compose.error.sendSignedOut'] }).waitFor();
			assert.equal(t.page.url(), address, `${tag}: the page did not leave for the sign-in`);
			assert.deepEqual(await t.chips('to'), ['maya.chen@lumen.test']);
			await t.editor.getByText('Hallo Maya').waitFor();
			await t.close();
		}
		{
			const t = await open({ sendStatus: 403 });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			await t.page.getByRole('alert').filter({ hasText: de['compose.error.sendNotAllowed'] }).waitFor();
			await t.noOverflow('with an error');
			// After the refusal, focus is back on Send, not lost on the page.
			await t.page.waitForFunction(text => document.activeElement?.textContent?.trim() === text, de['compose.send']);
			if (touch) { const close = await t.page.getByRole('alert').getByRole('button', { name: de['navigation.close'], exact: true }).boundingBox(); assert(close.width >= 44 && close.height >= 44, `${tag}: the notice's close button is finger-sized: ${JSON.stringify(close)}`); }
			await t.close();
		}
		// A success that names no message, or cannot be read, is not a send: the message stays and the
		// writer is sent to look before sending again.
		for (const sendBody of ['{}', '<html>gateway</html>']) {
			const t = await open({ sendBody });
			await t.input('to').fill('maya.chen@lumen.test');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Kurze Frage');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Maya');
			await t.send.click();
			await t.page.getByRole('alert').filter({ hasText: de['compose.error.sendCheckFirst'] }).waitFor();
			assert.equal(await t.page.getByText(de['compose.sent'], { exact: true }).count(), 0, `${tag}: not reported as sent`);
			assert.deepEqual(await t.chips('to'), ['maya.chen@lumen.test'], `${tag}: the message is still there`);
			await t.editor.getByText('Hallo Maya').waitFor();
			await t.close();
		}
		// A slow address book: Send waits for it instead of skipping the comparison.
		{
			const t = await open({ directoryDelay: 1500 });
			await t.input('to').fill('lin@harborwork.test,');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Unterlagen');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Lin');
			await t.send.click();
			// While Send waits, the message cannot be changed or closed: what is checked is what goes out.
			await t.page.waitForFunction(() => document.querySelector('form [aria-busy="true"]')?.inert === true);
			// Only the message is locked. The window itself can still be minimised or closed: a send that
			// hangs must not hold the whole screen.
			assert.equal(await t.form.getByRole('button', { name: de['compose.close'], exact: true }).evaluate(node => !node.closest('[inert]') && !node.disabled), true, `${tag}: Close stays usable while a send is prepared`);
			assert.equal(await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).evaluate(node => !!node.closest('[inert]')), true);
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Geändert', { force: true, timeout: 500 }).catch(() => {});
			const warning = t.page.locator('[data-send-warning]');
			await warning.waitFor();
			assert.equal(await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).inputValue(), 'Unterlagen', `${tag}: nothing was changed during the wait`);
			assert.equal(await t.page.evaluate(() => !!document.querySelector('form [inert]')), false, 'the message can be edited again once the question is asked');
			assert((await warning.innerText()).includes(label('compose.warn.lookalike', { address: 'lin@harborwork.test', like: 'harborworks.test' })), `${tag}: the look-alike is caught although the address book was late`);
			assert.equal(t.calls.sends.length, 0);
			await t.close();
		}
		// An address book that cannot be read: the writer is told that nothing was compared, and decides.
		{
			const t = await open({ directoryStatus: 503 });
			await t.input('to').fill('lin@harborwork.test,');
			await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).fill('Unterlagen');
			await t.editor.click();
			await t.page.keyboard.type('Hallo Lin');
			await t.send.click();
			const warning = t.page.locator('[data-send-warning]');
			await warning.getByText(de['compose.warn.unchecked'], { exact: true }).waitFor();
			assert.equal(t.calls.sends.length, 0);
			await warning.getByRole('button', { name: de['compose.warn.sendAnyway'], exact: true }).click();
			await t.page.getByText(de['compose.sent'], { exact: true }).waitFor();
			assert.equal(t.calls.sends.length, 1);
			await t.close();
		}
		// 6. A mail link starts a message with its recipients, subject and text; the text is text, never markup.
		{
			const t = await open({ mailto: 'mailto:lin@harborworks.test?cc=max@partner.test&subject=Angebot%20Seeblick&body=Hallo%20Lin%2C%0D%0A%0D%0A%3Cb%3Ebitte%3C%2Fb%3E%20um%20R%C3%BCckruf.' });
			await t.editor.getByText('um Rückruf').waitFor();
			assert.deepEqual(await t.chips('to'), ['lin@harborworks.test']);
			assert.deepEqual(await t.chips('cc'), ['max@partner.test'], `${tag}: Cc is open when the link names one`);
			assert.equal(await t.form.getByPlaceholder(de['compose.subject'], { exact: true }).inputValue(), 'Angebot Seeblick');
			assert.equal(await t.editor.locator('b').count(), 0, 'markup in a link stays visible text');
			assert.match(await t.editor.innerText(), /^Hallo Lin,\n+<b>bitte<\/b> um Rückruf\./);
			await t.page.waitForTimeout(1200);
			assert.equal(t.calls.saves.at(-1).to, 'lin@harborworks.test', 'the started message is saved as a draft like any other');
			await t.noOverflow('with a prefilled message');
			await t.close();
		}
		console.log(JSON.stringify({ ...config, dragBetweenLines: true, chipMenu: true, suggestions: true, sendWarnings: true, undoSend: true, mailLink: true, noOverflow: true }));
	}
} finally {
	await browser?.close();
	if (server) await new Promise(resolve => server.close(resolve));
	rmSync(dir, { recursive: true, force: true });
}
