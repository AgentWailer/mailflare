// Mail laid out in tables, shown by the production reader with production CSS: amounts, dates and
// ordinary words stay whole in their columns at phone width, and only a very long string (a link)
// breaks, so it does not make the message wider than the screen. The receipt is built like the
// payment receipts that showed "$", "1", "1", "4" below each other.
import { readProductionCss } from './helpers/production-css.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { build } from 'esbuild';

const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dir = mkdtempSync(join(root, 'node_modules', 'mailflare-mail-tables-browser-'));
const mails = {
	"stripe": "<html><head><style>@media only screen and (max-width: 600px){.st-Wrapper{min-width:100%!important;width:100%!important}.st-Width{width:100%!important;min-width:100%!important}}</style></head><body style=\"margin:0;background:#f6f9fc\">\n<table class=\"st-Wrapper\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:600px;min-width:600px;background:#fff;margin:0 auto\"><tbody><tr><td>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tbody><tr><td align=\"center\" style=\"font:24px Helvetica;color:#32325d;padding:24px\">Receipt from Obsidian</td></tr></tbody></table>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"padding:0 20px\"><tbody><tr>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Amount paid</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">$114.24</td></tr></tbody></table></td>\n<td width=\"20\"></td>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Date paid</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">November 27, 2026 at 5:52:31 PM EST</td></tr></tbody></table></td>\n<td width=\"20\"></td>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Payment method</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">American Express - 1002</td></tr></tbody></table></td>\n</tr></tbody></table>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f6f9fc;margin-top:24px\"><tbody><tr><td style=\"padding:20px\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tbody><tr>\n<td style=\"font:15px Helvetica;color:#525f7f;word-break:break-word\">Obsidian Sync yearly subscription (Plus 10 GB plan)</td>\n<td width=\"8\" style=\"width:8px\"></td>\n<td align=\"right\" valign=\"top\" style=\"font:15px Helvetica;color:#525f7f;word-break:break-word\">$114.24</td>\n</tr><tr><td colspan=\"3\" style=\"border-bottom:1px solid #e6ebf1;height:12px\"></td></tr><tr>\n<td style=\"font:bold 15px Helvetica;color:#525f7f\">Amount paid</td><td width=\"8\"></td>\n<td align=\"right\" style=\"font:bold 15px Helvetica;color:#525f7f\">$114.24</td>\n</tr></tbody></table></td></tr></tbody></table>\n<p style=\"font:15px Helvetica;color:#525f7f;padding:20px\">If you have any questions, visit our support site at <a href=\"https://help.obsidian.md\">https://help.obsidian.md</a> or contact us at <a href=\"mailto:support@obsidian.md\">support@obsidian.md</a>.</p>\n</td></tr></tbody></table></body></html>",
	"stripe100": "<html><head><style>@media only screen and (max-width: 600px){.st-Wrapper{min-width:100%!important;width:100%!important}.st-Width{width:100%!important;min-width:100%!important}}</style></head><body style=\"margin:0;background:#f6f9fc\">\n<table class=\"st-Wrapper\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:600px;min-width:600px;background:#fff;margin:0 auto\"><tbody><tr><td>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tbody><tr><td align=\"center\" style=\"font:24px Helvetica;color:#32325d;padding:24px\">Receipt from Obsidian</td></tr></tbody></table>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"padding:0 20px\"><tbody><tr>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Amount paid</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">$114.24</td></tr></tbody></table></td>\n<td width=\"20\"></td>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Date paid</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">November 27, 2026 at 5:52:31 PM EST</td></tr></tbody></table></td>\n<td width=\"20\"></td>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Payment method</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">American Express - 1002</td></tr></tbody></table></td>\n</tr></tbody></table>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f6f9fc;margin-top:24px\"><tbody><tr><td style=\"padding:20px\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tbody><tr>\n<td width=\"100%\" style=\"width:100%;font:15px Helvetica;color:#525f7f;word-break:break-word\">Obsidian Sync yearly subscription (Plus 10 GB plan)</td>\n<td width=\"8\" style=\"width:8px\"></td>\n<td align=\"right\" valign=\"top\" style=\"font:15px Helvetica;color:#525f7f;word-break:break-word\">$114.24</td>\n</tr><tr><td colspan=\"3\" style=\"border-bottom:1px solid #e6ebf1;height:12px\"></td></tr><tr>\n<td width=\"100%\" style=\"width:100%;font:bold 15px Helvetica;color:#525f7f\">Amount paid</td><td width=\"8\"></td>\n<td align=\"right\" style=\"font:bold 15px Helvetica;color:#525f7f\">$114.24</td>\n</tr></tbody></table></td></tr></tbody></table>\n<p style=\"font:15px Helvetica;color:#525f7f;padding:20px\">If you have any questions, visit our support site at <a href=\"https://help.obsidian.md\">https://help.obsidian.md</a> or contact us at <a href=\"mailto:support@obsidian.md\">support@obsidian.md</a>.</p>\n</td></tr></tbody></table></body></html>",
	"longlink": "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><td style=\"padding:16px;font:15px Arial\">Bitte bestätigen Sie Ihre Adresse über diesen Link:<br>https://example.com/confirm/8f2c1a9e7b6d4c3f2a1b0e9d8c7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f?utm_source=newsletter&amp;utm_medium=email<br><br>Vielen Dank!</td></tr></table>",
	"order": "<table width=\"100%\" cellpadding=\"6\" cellspacing=\"0\" style=\"font:14px Arial;border-collapse:collapse\"><tr style=\"background:#eee\"><th align=\"left\">Artikel</th><th>Menge</th><th align=\"right\">Einzelpreis</th><th align=\"right\">Summe</th></tr>\n<tr><td>Fahrradschlauch 28 Zoll mit Autoventil, extra pannensicher</td><td align=\"center\">2</td><td align=\"right\">7,99&nbsp;€</td><td align=\"right\">15,98 €</td></tr>\n<tr><td>Versicherungsbedingungen-Kettenschloss</td><td align=\"center\">1</td><td align=\"right\">1.249,00 €</td><td align=\"right\">1.249,00 €</td></tr>\n<tr><td colspan=\"3\" align=\"right\"><b>Gesamtsumme</b></td><td align=\"right\"><b>1.264,98 €</b></td></tr></table>",
	"stripebreak": "<html><head><style>td{overflow-wrap:anywhere}@media only screen and (max-width: 600px){.st-Wrapper{min-width:100%!important;width:100%!important}.st-Width{width:100%!important;min-width:100%!important}}</style></head><body style=\"margin:0;background:#f6f9fc\">\n<table class=\"st-Wrapper\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:600px;min-width:600px;background:#fff;margin:0 auto\"><tbody><tr><td>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tbody><tr><td align=\"center\" style=\"font:24px Helvetica;color:#32325d;padding:24px\">Receipt from Obsidian</td></tr></tbody></table>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"padding:0 20px\"><tbody><tr>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Amount paid</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">$114.24</td></tr></tbody></table></td>\n<td width=\"20\"></td>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Date paid</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">November 27, 2026 at 5:52:31 PM EST</td></tr></tbody></table></td>\n<td width=\"20\"></td>\n<td valign=\"top\"><table><tbody><tr><td style=\"font:bold 12px Helvetica;color:#8898aa;text-transform:uppercase;white-space:nowrap\">Payment method</td></tr><tr><td style=\"font:15px Helvetica;color:#525f7f\">American Express - 1002</td></tr></tbody></table></td>\n</tr></tbody></table>\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f6f9fc;margin-top:24px\"><tbody><tr><td style=\"padding:20px\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tbody><tr>\n<td width=\"100%\" style=\"width:100%;font:15px Helvetica;color:#525f7f;word-break:break-word\">Obsidian Sync yearly subscription (Plus 10 GB plan)</td>\n<td width=\"8\" style=\"width:8px\"></td>\n<td align=\"right\" valign=\"top\" style=\"font:15px Helvetica;color:#525f7f;word-break:break-word\">$114.24</td>\n</tr><tr><td colspan=\"3\" style=\"border-bottom:1px solid #e6ebf1;height:12px\"></td></tr><tr>\n<td width=\"100%\" style=\"width:100%;font:bold 15px Helvetica;color:#525f7f;word-break:break-word\">Amount paid</td><td width=\"8\"></td>\n<td align=\"right\" style=\"font:bold 15px Helvetica;color:#525f7f;word-break:break-word\">$114.24</td>\n</tr></tbody></table></td></tr></tbody></table>\n<p style=\"font:15px Helvetica;color:#525f7f;padding:20px\">If you have any questions, visit our support site at <a href=\"https://help.obsidian.md\">https://help.obsidian.md</a> or contact us at <a href=\"mailto:support@obsidian.md\">support@obsidian.md</a>.</p>\n</td></tr></tbody></table></body></html>",
	"code": "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><td style=\"padding:16px;font:15px Arial\"><p>Die Zustellung an den Webhook ist fehlgeschlagen:</p><p><code>https://hooks.production.example.com/v2/webhooks/stripe/whsec_8f2c1a9e7b6d4c3f2a1b0e9d8c7f6a5b4c3d2e1f0a9b8c7d</code></p><p>Bitte prüfen Sie die Adresse.</p></td></tr></table>",
	"splitlink": "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><td style=\"padding:16px;font:15px Arial\"><p>Ihr Link: <a href=\"https://example.com/x\"><span>https://example.com/konto/</span><b>bestaetigen/8f2c1a9e7b6d4c3f</b><span>2a1b0e9d8c7f6a5b4c3d2e1f</span></a></p><p>Dieser Absatz soll lesbar bleiben.</p></td></tr></table>",
	"tracking": "<table width=\"100%\" cellpadding=\"6\" cellspacing=\"0\" style=\"font:14px Arial\"><tr><td width=\"100%\" style=\"width:100%\">Sendungsverfolgung für Ihre Bestellung bei uns</td><td>https://tracking.example.com/sendung/00340434161094042557/status</td></tr><tr><td width=\"100%\" style=\"width:100%\">Rechnungsnummer</td><td>INV-2026-11-27-OBSIDIAN-SYNC-0001</td></tr></table>",
	"columns": "<table width=\"100%\" cellpadding=\"4\" cellspacing=\"0\" style=\"font:14px Arial;border-collapse:collapse\"><tr><th>Buchungstag</th><th>Wertstellung</th><th>Verwendungszweck</th><th>Auftraggeber</th><th>Betrag</th><th>Kontostand</th></tr><tr><td>27.11.2026</td><td>27.11.2026</td><td>Lastschrift Stadtwerke</td><td>Stadtwerke Beispielstadt</td><td align=\"right\">-84,20&nbsp;€</td><td align=\"right\">1.264,98&nbsp;€</td></tr><tr><td>26.11.2026</td><td>26.11.2026</td><td>Gehalt November</td><td>Arbeitgeber Beispiel GmbH</td><td align=\"right\">3.210,00&nbsp;€</td><td align=\"right\">1.349,18&nbsp;€</td></tr></table>"
};
writeFileSync(join(dir, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {EmailHtmlRenderer} from '@/components/messages/email-html-renderer';import {printMessage} from '@/components/messages/print-message';import {LanguageProvider} from '@/components/language-provider';import de from '../../public/locales/de.json';
const mails=${JSON.stringify(mails)};const params=new URLSearchParams(location.search),name=params.get('mail')!;
if(params.has('dark'))document.documentElement.classList.add('dark');
(window as never as {printMail:()=>void}).printMail=()=>{window.print=()=>{};printMessage({subject:'Beleg',headers:[{label:'Von',value:'billing@example.test'}],html:mails[name]});};
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><LanguageProvider initialLocale="de" initialMessages={de}><div style={{padding:'0 16px'}}><EmailHtmlRenderer html={mails[name]}/></div></LanguageProvider></QueryClientProvider>);`);

let browser, server;
try {
	await build({ entryPoints: [join(dir, 'entry.tsx')], outfile: join(dir, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic', tsconfig: join(root, 'tsconfig.json'), alias: { '@': join(root, 'src') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
	const assets = {
		'/': Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),
		'/fixture.js': readFileSync(join(dir, 'fixture.js')), '/fixture.css': readProductionCss(),
	};
	server = createServer((req, res) => { const path = new URL(req.url, 'http://localhost').pathname; if (path.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); } res.writeHead(assets[path] ? 200 : 404, { 'Content-Type': path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(assets[path] || 'Not found'); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = 'http://127.0.0.1:' + server.address().port;
	browser = await chromium.launch({ headless: true, executablePath: process.env.MAILFLARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });

	/** In the page: how each of `texts` is laid out inside the shadow root found by `find`. */
	const measure = (page, texts, printed = false) => page.evaluate(({ texts, printed }) => {
		const shadows = [];
		const collect = node => { for (const element of node.querySelectorAll('*')) if (element.shadowRoot) { shadows.push(element.shadowRoot); collect(element.shadowRoot); } };
		collect(document);
		const inPrint = shadow => { for (let host = shadow.host; host; host = host.getRootNode().host) if (host.id === 'mailflare-print-root') return true; return false; };
		const scope = shadows.filter(shadow => inPrint(shadow) === printed);
		// Every place the text stands at: a receipt names its amount in the summary, on the item and in the total.
		return texts.flatMap(text => {
			const found = [];
			for (const shadow of scope) {
				const walker = document.createTreeWalker(shadow, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					for (let at = node.data.indexOf(text); at >= 0; at = node.data.indexOf(text, at + text.length)) {
						const range = document.createRange();
						range.setStart(node, at); range.setEnd(node, at + text.length);
						const tops = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
						const box = range.getBoundingClientRect();
						found.push({ text, lines: tops.size, left: box.left, right: box.right });
					}
				}
			}
			return found.length ? found : [{ text, lines: 0 }];
		});
	}, { texts, printed });

	// What must stand on one line: amounts, dates, short labels. A receipt, the same with a label column
	// that claims the whole width (the case that left one character per line), and an order table.
	const whole = {
		stripe: ['$114.24', 'November', 'Date paid', 'Receipt from Obsidian'],
		stripe100: ['$114.24', 'November', 'Amount paid'],
		// The receipt as its sender styles it: `word-break:break-word` on every cell of the price column.
		stripebreak: ['$114.24', 'November', 'Amount paid'],
		order: ['15,98 €', '1.264,98', 'Einzelpreis', 'Fahrradschlauch', 'Gesamtsumme'],
		code: ['fehlgeschlagen', 'https://', 'Adresse.'],
		splitlink: ['lesbar'],
		// A long link and a long number beside a column that claims the whole width: pieces, never single characters.
		tracking: ['https://', 'tracking.', 'OBSIDIAN-', 'Rechnungsnummer'],
		columns: [],
	};
	// How small a message may get. Most must be shown at full size from 390 px on; a statement with six
	// columns cannot be, but must stay readable.
	const smallest = { columns: 0.6, splitlink: 0.6 };
	const fullFrom = { columns: 1440, splitlink: 820 };
	// The amount stands three times on a receipt, and each of them counts.
	const occurrences = { stripe: { '$114.24': 3 }, stripe100: { '$114.24': 3 }, stripebreak: { '$114.24': 3 } };
	for (const { width, height, dark } of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 390, height: 844, dark: true }, { width: 820, height: 1180 }, { width: 1440, height: 900 }]) {
		const tag = `${width}${dark ? '-dark' : ''}`;
		for (const name of Object.keys(mails)) {
			const page = await browser.newPage({ viewport: { width, height } });
			const errors = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`${origin}/?mail=${name}${dark ? '&dark=1' : ''}`);
			await page.waitForFunction(() => !!document.querySelector('[data-email-scale]'));
			await page.waitForTimeout(250);
			const scale = Number(await page.locator('[data-email-scale]').getAttribute('data-email-scale'));
			const results = await measure(page, whole[name] ?? []);
			for (const result of results) {
				assert.equal(result.lines, 1, `${tag} ${name}: "${result.text}" stands on one line, not broken inside the word: ${JSON.stringify(result)}`);
				assert(result.left >= 0 && result.right <= width + 0.5, `${tag} ${name}: "${result.text}" is inside the screen: ${JSON.stringify(result)}`);
			}
			for (const [text, count] of Object.entries(occurrences[name] ?? {})) assert.equal(results.filter(result => result.text === text).length, count, `${tag} ${name}: every "${text}" was measured`);
			assert(scale >= (smallest[name] ?? 0.85), `${tag} ${name}: the message stays readable, scale ${scale}`);
			if (width >= (fullFrom[name] ?? 390)) assert.equal(scale, 1, `${tag} ${name}: shown at full size`);
			if (name === 'longlink') {
				// The link is laid out in pieces. Where it starts and where the text after it stands tells over how many lines it runs.
				const [start] = await measure(page, ['https://']), [thanks] = await measure(page, ['Vielen Dank!']);
				assert.equal(scale, 1, `${tag}: a long link does not shrink the message`);
				assert.equal(start.lines, 1);
				assert.equal(thanks.lines, 1);
				const span = await page.evaluate(() => { const shadow = [...document.querySelectorAll('*')].find(element => element.shadowRoot).shadowRoot; const cell = shadow.querySelector('td'); return { height: cell.getBoundingClientRect().height, right: Math.max(...[...cell.querySelectorAll('wbr')].map(node => node.getBoundingClientRect().right)) }; });
				if (width < 800) assert(span.height > 120, `${tag}: the long link breaks over several lines: ${JSON.stringify(span)}`);
				assert(span.right <= width + 0.5, `${tag}: the long link stays inside the screen: ${JSON.stringify(span)}`);
			}
			const overflow = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
			assert(overflow.scroll <= overflow.client, `${tag} ${name}: the page does not scroll sideways: ${JSON.stringify(overflow)}`);
			if (width === 390 && !dark) await page.screenshot({ path: `/tmp/mailflare-mail-table-${name}-${tag}.png` });

			// The printout lays the same message out the same way.
			if (width === 390 && !dark) {
				await page.evaluate(() => window.printMail());
				await page.emulateMedia({ media: 'print' });
				await page.waitForTimeout(150);
				for (const result of await measure(page, (whole[name] ?? []).filter(text => name !== 'tracking' || text === 'Rechnungsnummer'), true)) assert.equal(result.lines, 1, `${tag} ${name}: on paper "${result.text}" stands on one line: ${JSON.stringify(result)}`);
			}
			assert.deepEqual(errors, [], `${tag} ${name}: page errors`);
			await page.close();
		}
		console.log(JSON.stringify({ width, height, dark: !!dark, wholeWords: true, longLinkBreaks: true, readableScale: true, noOverflow: true }));
	}
} finally {
	await browser?.close();
	await new Promise(resolve => (server ? server.close(resolve) : resolve()));
	rmSync(dir, { recursive: true, force: true });
}
