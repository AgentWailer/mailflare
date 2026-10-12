// Run after npm run build; supports the same browser tooling variables as message-action-menus.mjs.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-learning-browser-'));
const write=(name,value)=>writeFileSync(join(dir,name),value);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
write('compose.ts','export const useCompose=()=>({openComposer:()=>{}});');
write('mailbox.ts',`export const useSelectedMailbox=()=>({selectedMailbox:{id:new URLSearchParams(location.search).get('box')||'box',permission:new URLSearchParams(location.search).has('readonly')?'read_only':'full_access'},mailboxes:[],isLoading:false});`);
write('search.ts','export const useMailSearch=()=>({query:""});');
write('conversation.ts','export const useConversationView=()=>[false];');
write('sidebar.ts',`export const useSidebar=()=>({minimal:false,mobile:innerWidth<768,mobileOpen:true,toggle:()=>{}});`);
write('chrome.tsx',`export const SidebarHeader=()=> <div>Mailflare</div>;export const SidebarFooter=()=>null;`);
write('link.tsx',`export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>;}`);
write('navigation.ts',`export const usePathname=()=>new URLSearchParams(location.search).has('folder')?'/folders/work':'/inbox';export const useRouter=()=>({replace:path=>{window.replacedPath=path;},push:path=>{window.pushedPath=path;},prefetch:()=>{},refresh:()=>{}});`);
write('entry.tsx',`import React from 'react';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {createRoot} from 'react-dom/client';import {LanguageProvider} from '@/components/language-provider';import {DashboardNav} from '@/components/dashboard-nav';import {MailOrganizationButton} from '@/components/messages/mail-organization-button';import {MailSortingSettings} from '@/components/settings/mail-sorting-settings';import {InboxCategoryTabs} from '@/components/messages/inbox-category-tabs';import de from '../../public/locales/de.json';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}>{new URLSearchParams(location.search).has('categories')?<main className="w-full min-w-0"><InboxCategoryTabs folder="invoices" onRefresh={async()=>{}}/><MailOrganizationButton mailboxId="box" messageIds={['msg']}/></main>:new URLSearchParams(location.search).has('settings')?<main className="p-4"><MailSortingSettings/></main>:<><div style={{width:'min(280px,100vw)',height:'100dvh'}}><DashboardNav/></div><div style={{position:'fixed',top:16,right:16}}><MailOrganizationButton mailboxId="box" messageIds={['msg']}/></div></>}</LanguageProvider></QueryClientProvider>);`);

let server,browser;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src'),'@/components/compose/compose-context':join(dir,'compose.ts'),'@/components/mailbox-provider':join(dir,'mailbox.ts'),'@/components/sidebar-state':join(dir,'sidebar.ts'),'@/components/sidebar-header':join(dir,'chrome.tsx'),'@/components/mail-search/mail-search-context':join(dir,'search.ts'),'@/components/messages/use-conversation-view':join(dir,'conversation.ts'),'@/components/sidebar-footer':join(dir,'chrome.tsx'),'next/link':join(dir,'link.tsx'),'next/navigation':join(dir,'navigation.ts')},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-contexts',setup(b){b.onResolve({filter:/(?:^|\/)(compose-context|mailbox-provider|sidebar-state|sidebar-header|sidebar-footer)$/},args=>({path:join(dir,{'compose-context':'compose.ts','mailbox-provider':'mailbox.ts','sidebar-state':'sidebar.ts','sidebar-header':'chrome.tsx','sidebar-footer':'chrome.tsx'}[args.path.split('/').at(-1)])}));}}],logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(x=>x.startsWith('index.')&&x.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.MAILFLARE_CHROMIUM_EXECUTABLE?{executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 for(const size of [{width:320,height:700},{width:390,height:844},{width:844,height:390},{width:1440,height:900}]){
  const page=await browser.newPage({viewport:size,hasTouch:size.width<768}),errors=[],mutations=[];
  page.setDefaultTimeout(10000);page.on('pageerror',err=>{errors.push(err.message);console.error(err.message);});page.on('dialog',dialog=>dialog.accept());
  await page.route('**/api/**',route=>{const req=route.request(),url=new URL(req.url());if(req.method()!=='GET'){mutations.push({path:url.pathname,method:req.method(),body:req.postDataJSON()});return route.fulfill({contentType:'application/json',body:'{"ok":true}'});}
   let body={};if(url.pathname==='/api/folders')body={folders:[]};
   if(url.pathname==='/api/messages/counts')body={counts:{folders:Object.fromEntries(['inbox','promotions','social','invoices','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'].map(key=>[key,{total:0,unread:0}])),customFolders:{},mailboxes:[]}};
   if(url.pathname==='/api/mail-organization')body={canManage:true,messages:[{id:'msg',category:'primary',status:'received',folderId:null,sortingDecision:JSON.stringify({category:'promotions',source:'clef',reason:'bulk_review',reviewRequired:true}),labels:[]}]};
   if(url.pathname==='/api/settings/mail-sorting')body={settings:{mode:'active',threshold:.8,dailyLimit:1000},available:true,usage:{requests:3,inputTokens:12000},learningExamples:2,learningSummary:[{category:'invoices',count:1},{category:'orders',count:1}],overrides:[]};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(origin);const organize=page.getByRole('button',{name:de['smart.organize'],exact:true});await organize.click();const dialog=page.getByRole('dialog');await dialog.waitFor();await page.waitForTimeout(250);const box=await dialog.boundingBox();assert(box.x>=15&&box.y>=15&&box.x+box.width<=size.width-15&&box.y+box.height<=size.height-15);
  assert(await dialog.getByText(de['smart.learningHelp'],{exact:true}).isVisible());assert(await dialog.getByText(de['smart.reasonBulkReview'],{exact:true}).isVisible());
  const category=dialog.getByRole('combobox',{name:de['smart.category']});assert((await category.boundingBox()).height>=44);await category.selectOption('promotions');await dialog.getByRole('button',{name:de['rules.saveChanges'],exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(mutations[0].body.category,'promotions');assert.equal(mutations[0].body.rememberSender,false);
  // Exercise the real sidebar drop handler using the application's drag payload.
  await page.locator('a[href="/social"]').dispatchEvent('drop',{dataTransfer:await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('application/x-mailflare-message-ids',JSON.stringify({messageIds:['msg']}));return data;})});
  await page.waitForTimeout(150);assert.deepEqual(mutations[1].body,{mailboxId:'box',messageIds:['msg'],category:'social',skipInbox:false});
  await page.goto(origin+'/?settings=1');const threshold=page.getByRole('spinbutton',{name:de['smart.threshold']});await threshold.waitFor();assert.equal(await threshold.inputValue(),'80');assert.equal(await threshold.getAttribute('min'),'80');await page.getByRole('button',{name:de['rules.saveChanges'],exact:true}).click();await page.getByRole('status').waitFor();assert.equal(mutations[2].body.threshold,.8);
  await page.getByRole('button',{name:de['smart.clearLearning'],exact:true}).click();await page.waitForTimeout(150);assert.deepEqual(mutations[3].body,{mailboxId:'box',clearLearning:true});assert.equal(await page.getByRole('button',{name:de['smart.clearLearning'],exact:true}).count(),0);
  await page.goto(origin+'/?categories=1');const tabs=page.locator('[data-inbox-categories]');await tabs.waitFor();assert.equal(await tabs.getByRole('link').count(),5);
  const invoiceTab=tabs.locator('a[href="/invoices"]');assert.equal(await invoiceTab.getAttribute('aria-current'),'page');
  const orderTab=tabs.locator('a[href="/orders"]');await orderTab.scrollIntoViewIfNeeded();await orderTab.click();assert.equal(await page.evaluate(()=>window.pushedPath),'/orders');
  for(const link of await tabs.getByRole('link').all()){await link.scrollIntoViewIfNeeded();const b=await link.boundingBox();assert(b.height>=44&&b.width>=90);}
  await page.getByRole('button',{name:de['smart.organize'],exact:true}).click();const financialDialog=page.getByRole('dialog');await financialDialog.waitFor();const financialSelect=financialDialog.getByRole('combobox',{name:de['smart.category']});await financialSelect.selectOption('invoices');await financialDialog.getByRole('button',{name:de['rules.saveChanges'],exact:true}).click();await financialDialog.waitFor({state:'hidden'});assert.equal(mutations.at(-1).body.category,'invoices');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport:size,learningHelpAndReviewReason:true,categoryCorrection:true,sidebarDrop:true,threshold80:true,clearLearning:true}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
