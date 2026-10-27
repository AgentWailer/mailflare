// Real composer and production CSS with synthetic APIs; never sends live mail.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-compose-browser-'));
const write=(name,content)=>writeFileSync(join(dir,name),content);
write('navigation.ts',`export const useRouter=()=>({push:()=>{},replace:()=>{}});`);
write('mailbox.ts',`const mailbox={id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',signature:'',senderAddresses:['owner@example.test']};export const useSelectedMailbox=()=>({selectedMailbox:mailbox,mailboxes:[mailbox],setSelectedMailbox:()=>{}});`);
write('entry.tsx',`import {setClientSessionToken} from '@/lib/auth/client';window.__setSession=setClientSessionToken;import React from 'react';import {createRoot} from 'react-dom/client';import {ComposeForm} from '@/components/compose/compose-form';import {LanguageProvider} from '@/components/language-provider';import de from '../../public/locales/de.json';const params=new URLSearchParams(location.search);if(params.has('dark'))document.documentElement.classList.add('dark');createRoot(document.getElementById('root')!).render(<LanguageProvider initialLocale="de" initialMessages={de}><ComposeForm mode="popup" draftIdToLoad={params.has('draft')?'draft':undefined} onClose={()=>window.__closed=true}/></LanguageProvider>);`);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
let browser,server;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src'),'@/components/mailbox-provider':join(dir,'mailbox.ts'),'next/navigation':join(dir,'navigation.ts')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(x=>x.startsWith('index.')&&x.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0;background:#f6f8fc"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});

 const page=await browser.newPage({viewport:{width:1440,height:900}}),pending=[],writes=[];await page.addInitScript(()=>localStorage.setItem('mailflare-session-token','test-session'));page.on('dialog',dialog=>dialog.accept());
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='POST'&&path==='/api/drafts'){writes.push(req.postDataJSON());pending.push(route);return;}
  return route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/api/attachment-policy'?{maxMb:25,cloudThresholdBytes:3000000}:path==='/api/templates'?{templates:[]}:{draft:{id:'saved'}})});
 });
 await page.goto(origin);const editor=page.locator('[contenteditable="true"]').first();await editor.fill('Audit first revision');await page.waitForTimeout(1200);await editor.fill('Audit second revision');await page.waitForTimeout(1200);
 assert.equal(pending.length,1,'slow creation is serialized');console.log(JSON.stringify({singleCreation:true}));
 for(let i=0;i<pending.length;i++)await pending[i].fulfill({contentType:'application/json',body:JSON.stringify({draft:{id:'saved-'+i}})});
 await page.waitForTimeout(1100);await editor.fill('Audit unsaved final revision');await page.reload();await page.waitForTimeout(1200);
 assert((await page.locator('[contenteditable="true"]').first().innerText()).includes('unsaved final revision'),'unacknowledged final text restored after reload');console.log(JSON.stringify({reloadRestoresLatest:true}));
 await page.close();
 const retryPage=await browser.newPage({viewport:{width:390,height:844}});await retryPage.addInitScript(()=>localStorage.setItem('mailflare-session-token','owner'));let attempts=0;const requests=[],patches=[];
 await retryPage.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;
  if(path==='/api/drafts'&&req.method()==='POST'){requests.push(req.postDataJSON());if(++attempts===1)return route.abort('failed');return route.fulfill({contentType:'application/json',body:JSON.stringify({draft:{id:'same-draft',reused:true}})});}
  if(path==='/api/drafts/same-draft'&&req.method()==='PATCH')patches.push(req.postDataJSON());
  return route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/api/templates'?{templates:[]}:{draft:{id:'same-draft'}})});
 });
 await retryPage.goto(origin);const retryEditor=retryPage.locator('[contenteditable="true"]').first();await retryEditor.fill('Accepted but response lost');await retryPage.getByRole('alert').waitFor();await retryEditor.fill('Latest revision after lost response');await retryPage.waitForTimeout(1500);
 assert.equal(requests.length,2);assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(patches.at(-1).text,'Latest revision after lost response');
 await retryEditor.fill('Unsaved owner text');await retryPage.waitForTimeout(50);await retryPage.evaluate(()=>window.__setSession('other'));assert.equal(await retryPage.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('mailflare-compose-recovery:')).length),0);
 console.log(JSON.stringify({lostCreationResponseRetry:true,latestRevisionPatched:true,sessionChangeClearsJournal:true}));await retryPage.close();

 const discard=await browser.newPage({viewport:{width:390,height:844}});let held,deleted=0;
 await discard.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;if(path==='/api/drafts'&&req.method()==='POST'){held=route;return;}if(req.method()==='DELETE')deleted++;return route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/api/templates'?{templates:[]}:{draft:{id:'discard'}})});});
 await discard.goto(origin);await discard.locator('[contenteditable="true"]').first().fill('Discard while saving');await discard.waitForTimeout(1200);assert(held);await discard.getByRole('button',{name:de['compose.deleteDraft'],exact:true}).click();assert.equal(deleted,0);await held.fulfill({contentType:'application/json',body:JSON.stringify({draft:{id:'discard'}})});await discard.waitForFunction(()=>window.__closed===true);assert.equal(deleted,1);console.log(JSON.stringify({discardWaitsForCreation:true}));await discard.close();

 const failedDelete=await browser.newPage({viewport:{width:390,height:844}});
 await failedDelete.route('**/api/**',route=>route.fulfill({status:route.request().method()==='DELETE'?500:200,contentType:'application/json',body:JSON.stringify(new URL(route.request().url()).pathname==='/api/templates'?{templates:[]}:{draft:{id:'keep'}})}));
 await failedDelete.goto(origin);const kept=failedDelete.locator('[contenteditable="true"]').first();await kept.fill('Keep my text when delete fails');await failedDelete.waitForTimeout(1200);await failedDelete.getByRole('button',{name:de['compose.deleteDraft'],exact:true}).click();await failedDelete.waitForTimeout(300);assert.equal(await failedDelete.evaluate(()=>window.__closed===true),false);assert((await kept.innerText()).includes('Keep my text'));console.log(JSON.stringify({failedDeleteKeepsText:true}));await failedDelete.close();

}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
