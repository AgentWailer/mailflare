// Real language provider and Radix controls with production CSS; synthetic local UI only.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProductionCss } from './helpers/production-css.mjs';

const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const directory = mkdtempSync(join(root, 'node_modules', 'language-selector-browser-'));
let server, browser;
try {
  writeFileSync(join(directory, 'entry.tsx'), `
    import {createRoot} from 'react-dom/client';
    import {LanguageProvider} from '../../src/components/language-provider';
    import {LanguageSelector} from '../../src/components/language-selector';
    import {Dialog,DialogTrigger,DialogContent,DialogTitle,DialogDescription} from '../../src/components/ui/dialog';
    createRoot(document.getElementById('root')).render(<LanguageProvider initialLocale="en">
      <main style={{padding:24,display:'grid',gap:24,maxWidth:320}}>
        <div id="field"><LanguageSelector/></div><div id="text"><LanguageSelector variant="text"/></div>
        <Dialog><DialogTrigger>Open settings</DialogTrigger><DialogContent>
          <DialogTitle>Settings</DialogTitle><DialogDescription>Language preferences</DialogDescription>
          <LanguageSelector/>
        </DialogContent></Dialog>
      </main>
    </LanguageProvider>);
  `);
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic', tsconfig: 'tsconfig.json', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const assets = { '/fixture.js': readFileSync(join(directory, 'fixture.js')), '/fixture.css': readProductionCss() };
  const html = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    const catalog = /^\/locales\/(de|ar)\.json$/.test(path);
    response.writeHead(200, { 'Content-Type': catalog ? 'application/json' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
    response.end(catalog ? readFileSync(join(root, 'public', path)) : assets[path] ?? html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.MAILFLARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  for (const width of [1280, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 568 }, hasTouch: width === 320 });
    const activate = locator => width === 320 ? locator.tap() : locator.click();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    for (const variant of ['field', 'text']) {
      const trigger = page.locator(`#${variant}`).getByRole('combobox');
      if (await page.locator('html').getAttribute('lang') !== 'en') {
        await activate(trigger);
        await activate(page.getByRole('option', { name: 'English', exact: true }));
        await page.waitForFunction(() => document.documentElement.lang === 'en');
      }
      await activate(trigger);
      const list = page.getByRole('listbox');
      await list.waitFor();
      const bounds = await list.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 569, 'menu stays inside viewport');
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Hausa');
      const last = await page.getByRole('option', { name: 'Hausa', exact: true }).boundingBox();
      assert(last.y >= bounds.y && last.y + last.height <= bounds.y + bounds.height + 1, 'keyboard scrolls the last option into view: ' + JSON.stringify({ width, variant, bounds, last }));
      await page.keyboard.press('Home');
      await page.waitForFunction(() => document.activeElement?.textContent === 'English');
      await page.keyboard.type('Deutsch');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Deutsch');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.lang === 'de');
      assert.match(await trigger.textContent(), /Deutsch/);
      assert.match(await page.evaluate(() => document.cookie), /mailflare-locale=de/);
      await activate(trigger);
      await page.keyboard.press('End');
      await page.keyboard.press('Escape');
      await list.waitFor({ state: 'hidden' });
      await page.waitForFunction(selector => document.querySelector(selector) === document.activeElement, `#${variant} [role="combobox"]`);
      assert(await trigger.evaluate(element => element === document.activeElement), 'Escape restores trigger focus');
      assert.match(await trigger.textContent(), /Deutsch/, 'Escape keeps the selected language');
    }
    await activate(page.getByRole('button', { name: 'Open settings', exact: true }));
    const dialog = page.getByRole('dialog');
    const dialogTrigger = dialog.getByRole('combobox');
    await activate(dialogTrigger);
    await activate(page.getByRole('option', { name: 'العربية', exact: true }));
    await page.waitForFunction(() => document.documentElement.lang === 'ar' && document.documentElement.dir === 'rtl');
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [role="combobox"]') === document.activeElement);
    assert(await dialog.isVisible(), 'choosing a portaled option keeps the settings dialog open');
    assert(await dialogTrigger.evaluate(element => element === document.activeElement), 'selection restores focus inside the dialog');
    await activate(dialogTrigger);
    assert.equal(await page.getByRole('listbox').evaluate(element => getComputedStyle(element).direction), 'rtl');
    await page.keyboard.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    assert(await dialog.isVisible(), 'Escape dismisses only the language menu');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, variants: ['field', 'text'], keyboard: true, scrolling: true, rtl: true, dialogFocus: true }));
    await page.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
