// Real rule editor + background job observer, with controlled HTTP boundaries.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-rule-apply-browser-'));
const write=(name,value)=>writeFileSync(join(dir,name),value),de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
write('mailbox.ts',`export const useSelectedMailbox=()=>({selectedMailbox:{id:'box',permission:'full_access'},mailboxes:[],isLoading:false});`);
write('entry.tsx',`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LanguageProvider} from '@/components/language-provider';import {InboxRules} from '@/components/settings/inbox-rules';import de from '../../public/locales/de.json';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}><main style={{padding:16}}><InboxRules/></main></LanguageProvider></QueryClientProvider>);`);
let browser,server;
try {
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src'),'@/components/mailbox-provider':join(dir,'mailbox.ts')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(name=>name.startsWith('index.')&&name.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.MAILFLARE_CHROMIUM_EXECUTABLE?{executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 for(const viewport of [{width:320,height:700},{width:390,height:844},{width:1440,height:900}]){
  const page=await browser.newPage({viewport,hasTouch:viewport.width<768}),errors=[],writes=[],applies=[];let job=null,failApply=false;
  const rule={id:'existing',enabled:true,conditions:'[]',conditionMode:'all',pattern:'supplier@example.test',matchField:'sender',matchOperator:'exact',matchValue:'supplier@example.test',labelIds:'["work"]',category:'invoices',skipInbox:false,action:'store',folderId:null,forwardTo:null,priority:10};
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());let body={},status=200;
   if(url.pathname==='/api/folders')body={folders:[{id:'work',name:'Arbeit',parentId:null}]};
   else if(url.pathname==='/api/messages/bulk-jobs')body={job};
   else if(url.pathname.endsWith('/apply')){
    applies.push({url:url.pathname,...req.postDataJSON()});
    if(failApply){status=503;body={error:'Temporary failure'};}else{job={id:'job',requestId:req.postDataJSON().requestId,action:'applyRule',status:'running',processed:0,total:20000,scope:{folder:'all',mailboxId:'box',query:'',unreadOnly:false,title:'supplier@example.test'}};body={job};status=202;}
   }else if(url.pathname==='/api/routing-rules'&&req.method()==='GET')body={rules:[rule]};
   else if(url.pathname.startsWith('/api/routing-rules')){writes.push({method:req.method(),...req.postDataJSON()});body={id:'created',ok:true};}
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(origin);const existingApply=page.getByRole('button',{name:de['rules.applyExisting'],exact:true});await existingApply.waitFor();assert((await existingApply.boundingBox()).height>=44);await existingApply.click();let dialog=page.getByRole('dialog');await dialog.getByRole('checkbox',{name:de['rules.includeSpamTrash'],exact:true}).check();await dialog.getByRole('button',{name:de['rules.applyStart'],exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(applies[0].includeSpamTrash,true);assert.equal(writes.length,0);await page.getByRole('status').filter({hasText:'Nachrichten geprüft'}).waitFor();assert(await existingApply.isDisabled());
  job={...job,status:'done',processed:20000};await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('status').filter({hasText:'Regel angewendet'}).waitFor();await page.getByRole('button',{name:de['navigation.close'],exact:true}).click();job=null;
  await page.getByRole('button',{name:de['rules.new'],exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel(de['rules.valueLabel'],{exact:true}).fill('supplier@example.test');await dialog.getByRole('checkbox',{name:'Arbeit',exact:true}).check();const alsoApply=dialog.getByRole('checkbox',{name:de['rules.alsoApplyExisting'],exact:true});assert(!(await alsoApply.isChecked()));await alsoApply.check();failApply=true;await dialog.getByRole('button',{name:de['rules.saveChanges'],exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(writes.at(-1).method,'POST');const creationCount=writes.filter(x=>x.method==='POST').length,requestId=applies.at(-1).requestId;
  failApply=false;await dialog.getByRole('button',{name:de['rules.saveChanges'],exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(writes.filter(x=>x.method==='POST').length,creationCount,'retry must not create the saved rule twice');assert.equal(writes.at(-1).method,'PATCH');assert.equal(applies.at(-1).requestId,requestId,'retry acceptance keeps its idempotency key');assert.equal(applies.at(-1).includeSpamTrash,false);
  await page.reload();await page.getByRole('status').filter({hasText:'Nachrichten geprüft'}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  if(viewport.width===390)await page.screenshot({path:'/tmp/mailflare-rule-application-mobile.png'});
  console.log(JSON.stringify({viewport,existingRuleApply:true,optionalSpamTrash:true,newRuleApply:true,retryWithoutDuplicateRule:true,restoresJobAfterReload:true,overflow:false}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
