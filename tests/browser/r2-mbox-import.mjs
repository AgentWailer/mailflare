import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const {chromium}=await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mbox-browser-')),de=JSON.parse(readFileSync('public/locales/de.json','utf8'));
writeFileSync(join(dir,'mailbox.ts'),"export const useSelectedMailbox=()=>({selectedMailbox:{id:'box',permission:location.search.includes('readonly')?'read_only':'full_access'}});");
writeFileSync(join(dir,'user.ts'),"export const useCurrentUser=()=>({id:'admin',role:location.search.includes('nonadmin')?'user':'admin'});");
writeFileSync(join(dir,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LanguageProvider} from '@/components/language-provider';import {R2MboxImport} from '@/components/settings/r2-mbox-import';import de from '../../public/locales/de.json';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}><main className="p-4"><R2MboxImport/></main></LanguageProvider></QueryClientProvider>);`);
let browser,server;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'@':join(root,'src'),'@/components/mailbox-provider':join(dir,'mailbox.ts'),'@/hooks/use-current-user':join(dir,'user.ts')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(x=>x.startsWith('index.')&&x.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 for(const viewport of [{width:320,height:700},{width:390,height:844},{width:820,height:1180},{width:1440,height:900}]){
  const page=await browser.newPage({viewport,hasTouch:viewport.width<1024}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  let jobs=[],configured=true;const controls=[],sortingControls=[];const issues=[{id:"issue",byte_offset:0,next_offset:345,message_size:30*1024**2,reason:"oversized",error:"Message exceeds processing limit. "+"long reason ".repeat(30),status:"pending"}];
  await page.route('**/api/import/mbox/jobs**',async route=>{const request=route.request();
   if(new URL(request.url()).pathname.endsWith('/issues')){
    if(request.method()==='POST'){issues[0].status='dismissed';jobs[0].issues.pending=0;}
    if(new URL(request.url()).searchParams.has('download'))return route.fulfill({contentType:'application/mbox',body:'From sender Wed Jan 01 12:00:00 2025\nSubject: Original message\n\nBody'});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({issues,next:null})});
   }
   if(request.method()==='POST'){
    const body=request.postDataJSON();if(new URL(request.url()).pathname.endsWith('/sorting')){sortingControls.push(body.action);if(body.action==='start')jobs[0].sorting={status:'running',processed:0,primary:0,promotions:0,social:0,error:null,waitReason:null,retryAt:0};else if(body.action==='pause')jobs[0].sorting.status='paused';else if(body.action==='resume')jobs[0].sorting.status='running';}else if(body.objectKey)jobs=[{id:'job',mailboxId:'box',objectKey:body.objectKey,size:10*1024**3,offset:0,processed:0,imported:0,skipped:0,status:'running',progress:0,error:null,canSkip:false}];
    else {controls.push(body.action);const job=jobs[0];if(body.action==='pause')job.status='paused';if(body.action==='resume'){job.status='running';job.error=null;}if(body.action==='skip'){job.status='paused';job.skipped++;job.processed++;job.error=null;job.canSkip=false;}}
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify({jobs,job:jobs[0],backgroundQueueConfigured:configured,sortingAvailable:configured})});
  });
  await page.goto(origin);const start=page.getByRole('button',{name:de['mbox.start'],exact:true});await start.waitFor();
  await page.getByLabel(de['mbox.objectKey']).fill('mbox-imports/'+'archive-long-name-'.repeat(9)+'.mbox');await start.click();const pause=page.getByRole('button',{name:de['mbox.pause'],exact:true});await pause.waitFor();await pause.click();const resume=page.getByRole('button',{name:de['mbox.resume'],exact:true});await resume.waitFor();
  jobs[0].processed=17;jobs[0].imported=17;jobs[0].offset=1024**3;jobs[0].progress=10;await page.reload();await resume.waitFor();assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'10');await resume.click();await pause.waitFor();
  jobs[0].status='failed';jobs[0].error='Temporary R2 error: '+('long'.repeat(100));jobs[0].canSkip=true;await page.reload();const skip=page.getByRole('button',{name:de['mbox.skip'],exact:true});await skip.waitFor();const bounds=await skip.boundingBox();assert(bounds.height>=44);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await skip.click();await resume.waitFor();assert.equal(jobs[0].skipped,1);await resume.click();
  jobs[0].status='completed';jobs[0].progress=100;await page.reload();await page.getByText(new RegExp(de['mbox.status.completed'])).waitFor();assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'100');assert.equal(await pause.count(),0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  jobs[0].issues={total:1,pending:1};await page.reload();const issuePanel=page.locator('[data-mbox-issues]');await issuePanel.getByRole('button').first().click();await issuePanel.getByText(de['mbox.issues.reason.oversized'],{exact:false}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const downloadPromise=page.waitForEvent('download');await issuePanel.getByRole('button',{name:de['mbox.issues.download'],exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'message-0.mbox');
  await issuePanel.getByRole('button',{name:de['mbox.issues.dismiss'],exact:true}).click();await issuePanel.getByText(de['mbox.issues.reviewed'],{exact:true}).waitFor();assert.equal(jobs[0].issues.pending,0);
  const sorting=page.locator('[data-mbox-sorting]');await sorting.getByRole('button',{name:de['mbox.sorting.start'],exact:true}).click();await sorting.getByRole('button',{name:de['mbox.sorting.pause'],exact:true}).click();await sorting.getByRole('button',{name:de['mbox.sorting.resume'],exact:true}).waitFor();
  jobs[0].sorting.processed=4;jobs[0].sorting.promotions=3;jobs[0].sorting.primary=1;await page.reload();await sorting.getByText(/4 geprüft/).waitFor();await sorting.getByRole('button',{name:de['mbox.sorting.resume'],exact:true}).click();await sorting.getByRole('button',{name:de['mbox.sorting.pause'],exact:true}).waitFor();
  jobs[0].sorting.status='waiting';jobs[0].sorting.waitReason='daily_limit';await page.reload();await sorting.getByText(de['mbox.sorting.wait.daily_limit'],{exact:true}).waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(sortingControls,['start','pause','resume']);
  await page.goto(origin+'/?readonly');await start.waitFor();assert(await start.isDisabled());configured=false;await page.goto(origin);await page.getByText(de['mbox.missingQueue'],{exact:true}).waitFor();assert(await start.isDisabled());
  await page.goto(origin+'/?nonadmin');assert.equal(await start.count(),0);assert.deepEqual(errors,[]);assert.deepEqual(controls,['pause','resume','skip','resume']);
  console.log(JSON.stringify({viewport,startPauseResume:true,persistedProgressAfterReload:true,separateSortingControls:true,persistedSortingProgress:true,dailyLimitDisplayed:true,explicitSkip:true,issueReviewAndDownload:true,completed:true,privateAdminOnly:true,readOnlyGuard:true,noOverflow:true}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
