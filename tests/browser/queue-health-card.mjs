import { readProductionCss } from './helpers/production-css.mjs';
// Isolated component interaction/visual check using synthetic queue notices; no live mailbox or queue access.
// Run after a build: node tests/browser/queue-health-card.mjs
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,mkdirSync} from 'node:fs';
import {chromium} from 'playwright';

const catalog=JSON.parse(readFileSync('public/locales/de.json','utf8'));
const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AdminQueueHealthCard} from './src/components/admin-queue-health-card';createRoot(document.getElementById('app')).render(React.createElement(AdminQueueHealthCard));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',tsconfig:'tsconfig.json',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'synthetic-context',setup(builder){builder.onResolve({filter:/^@\/(components\/language-provider|lib\/auth\/client)$/},args=>({path:args.path,namespace:'synthetic'}));builder.onLoad({filter:/.*/,namespace:'synthetic'},args=>({contents:args.path.endsWith('language-provider')?`const messages=${JSON.stringify(catalog)};export function useLanguage(){return {locale:'de',t:(key,vars)=>messages[key].replace(/\\{(\\w+)\\}/g,(match,name)=>String(vars?.[name]??match))}}`:`export function authFetch(_path,options){return fetch('https://mailflare.test/api/admin/queue-health',options)}`,loader:'js'}));}}]});
const css=readProductionCss().toString('utf8');
const output=process.env.QUEUE_HEALTH_VISUAL_OUTPUT||'/tmp/mailflare-queue-health';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
try{
 for(const width of [320,390,1280]){
  const page=await browser.newPage({viewport:{width,height:850},locale:'de-DE'});let calls=0,fail=false;
  await page.route('https://mailflare.test/api/admin/queue-health',async route=>{calls++;await route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(fail?{error:'queue_status_unavailable'}:{count:2,hasMore:false,since:'2026-10-26T00:00:00Z',recent:[{kind:'inbound',category:'Error',attempts:4,createdAt:'2026-11-02T10:00:00Z'},{kind:'paperless',category:'TimeoutError',attempts:4,createdAt:'2026-11-02T09:00:00Z'}]})});});
  await page.setContent('<html lang="de"><head></head><body style="background:#f5f7fa"><main id="app" style="max-width:768px;margin:24px auto;padding:12px"></main></body></html>');
  await page.addStyleTag({content:css});await page.addScriptTag({content:result.outputFiles[0].text});
  await page.getByText('2 Fehlermeldungen wurden in den letzten 7 Tagen erfasst.').waitFor();assert.equal(calls,1);
  await page.getByText('Letzte Fehler',{exact:true}).click();await page.getByText('Paperless-Übertragung',{exact:true}).waitFor();
  assert(await page.getByText(/nicht die aktuelle Anzahl/).isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  await page.screenshot({path:`${output}/${width}-queue-health.png`,fullPage:true});
  fail=true;await page.getByRole('button',{name:'Status aktualisieren'}).click();await page.getByText('Der Verarbeitungsstatus konnte nicht geladen werden.').waitFor();
  fail=false;await page.getByRole('button',{name:'Status aktualisieren'}).click();await page.getByText('2 Fehlermeldungen wurden in den letzten 7 Tagen erfasst.').waitFor();assert.equal(calls,3);
  await page.close();
 }
 console.log('Queue health card: 320/390/1280px, initial load, disclosure, failed refresh and recovery passed; '+output);
}finally{await browser.close();}
