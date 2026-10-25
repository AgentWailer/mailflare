// Actual setup component and production CSS; no key or external email service.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const dir=mkdtempSync(join(process.cwd(),'node_modules','chatgpt-browser-'));let browser;
try {
 await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {LanguageProvider} from './src/components/language-provider';import {ChatGptActionSetup} from './src/components/settings/chatgpt-action-setup';import de from './public/locales/de.json';createRoot(document.getElementById('root')).render(<LanguageProvider initialLocale="de" initialMessages={de}><main className="p-4"><div className="p-4"><div className="p-4"><ChatGptActionSetup mailboxes={[{id:'one',address:'one@example.test'},{id:'two',address:'two@example.test'}]}/></div></div></main></LanguageProvider>);`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(dir,'app.js'),bundle:true,format:'esm',platform:'browser',tsconfig:'tsconfig.json',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDirectory='dist/client/_next/static/css',css=readFileSync(join(cssDirectory,readdirSync(cssDirectory).find(name=>name.startsWith('index.')&&name.endsWith('.css'))));
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const viewport of [{width:320,height:700},{width:390,height:844},{width:1440,height:900}]){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://mailflare.test/**',async route=>{const path=new URL(route.request().url()).pathname;await route.fulfill({contentType:path==='/app.js'?'text/javascript':path==='/app.css'?'text/css':'text/html',body:path==='/app.js'?readFileSync(join(dir,'app.js')):path==='/app.css'?css:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>'});});
  await page.goto('https://mailflare.test/');await page.locator('summary').click();await page.getByRole('combobox').selectOption('two');
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'ChatGPT-Vorlage herunterladen',exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'mailflare-chatgpt-action.json');
  const document=JSON.parse(readFileSync(await download.path(),'utf8')),operation=document.paths['/api/v1/send'].post;assert.deepEqual(document.servers,[{url:'https://mailflare.test'}]);assert.deepEqual(operation.requestBody.content['application/json'].schema.properties.mailboxId.enum,['two']);assert.deepEqual(operation.requestBody.content['application/json'].schema.properties.from.enum,['two@example.test']);assert.equal(operation['x-openai-isConsequential'],true);assert(!JSON.stringify(document).includes('ep_'));
  assert(await page.evaluate(()=>window.document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport,mailboxSelected:true,downloadValid:true,noCredentialInTemplate:true,noOverflow:true}));await page.close();
 }
}finally{await browser?.close();rmSync(dir,{recursive:true,force:true});}
