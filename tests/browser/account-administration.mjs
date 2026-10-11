// Run after npm run build. Tests real account pages with mocked HTTP responses.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-accounts-browser-'));
const write=(name,value)=>writeFileSync(join(dir,name),value);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
write('navigation.ts',`export const useParams=()=>({id:new URLSearchParams(location.search).get('id')||'target'});export const useRouter=()=>({push:path=>{window.navigatedPath=path;},refresh:()=>{window.refreshCount=(window.refreshCount||0)+1;}});`);
write('link.tsx',`export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>;}`);
write('user.ts',`export const useCurrentUser=()=>({id:'primary',isPrimaryAdmin:true,role:'admin',canManageUsers:true});`);
write('entry.tsx',`import React from 'react';import {createRoot} from 'react-dom/client';import {LanguageProvider} from '@/components/language-provider';import Accounts from '@/app/(admin)/accounts/page';import Details from '@/app/(admin)/accounts/[id]/page';import Activity from '@/app/(admin)/activity/page';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MailboxProvider,useSelectedMailbox} from '@/components/mailbox-provider';import de from '../../public/locales/de.json';
if(new URLSearchParams(location.search).has('dark'))document.documentElement.classList.add('dark');
function Probe(){const {mailboxes}=useSelectedMailbox();return <output data-testid="mailboxes">{mailboxes.map(x=>x.id).join(',')}</output>;}
createRoot(document.getElementById('root')!).render(<LanguageProvider initialLocale="de" initialMessages={de}><QueryClientProvider client={new QueryClient()}><MailboxProvider><main className="p-4 md:p-8"><div className="mx-auto max-w-4xl">{new URLSearchParams(location.search).has('activity')?<Activity/>:new URLSearchParams(location.search).has('details')?<Details/>:<Accounts/>}</div></main><Probe/></MailboxProvider></QueryClientProvider></LanguageProvider>);`);
let server,browser;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src'),'@/hooks/use-current-user':join(dir,'user.ts'),'next/navigation':join(dir,'navigation.ts'),'next/link':join(dir,'link.tsx')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(x=>x.startsWith('index.')&&x.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.MAILFLARE_CHROMIUM_EXECUTABLE?{executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 for(const size of [{width:320,height:700},{width:390,height:844},{width:844,height:390},{width:1440,height:900}]){
  const page=await browser.newPage({viewport:size,hasTouch:size.width<768});const errors=[],deletions=[];let failDelete=false,pendingResolve,transferred=false;
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const accounts=[{id:'primary',email:'primary@example.test',name:'Administrator',role:'admin',isPrimaryAdmin:true,disabled:false},{id:'target',email:'target@example.test',name:'Ein sehr langer Kontoname mit vielen Wörtern und zusätzlichen Informationen',role:'user',disabled:true}];
  await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;
   if(req.method()==='DELETE'){
    deletions.push({path,body:req.postDataJSON()});if(failDelete)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Testfehler: Konto bleibt erhalten'})});
    if(pendingResolve)await new Promise(resolve=>{pendingResolve.resolve=resolve;});
    transferred=true;return route.fulfill({contentType:'application/json',body:'{"ok":true,"cleanupPending":false}'});
   }
   const id=path.split('/').at(-1),account=accounts.find(x=>x.id===id);
   const body=path==='/api/activity'?{activities:[{id:'deletion',action:'account.deleted',actorEmail:'primary@example.test',createdAt:'2026-10-11T15:30:00Z',metadata:JSON.stringify({email:'target@example.test',assetsTransferredTo:'primary',pendingAvatarCleanup:['old-avatar']})}]}:path==='/api/mailboxes'?{mailboxes:[{id:'primarybox',domainId:'domain',localPart:'primary',hostname:'example.test',isPrimary:true},...(transferred?[{id:'transferredbox',domainId:'domain',localPart:'target',hostname:'example.test'}]:[])]}:path==='/api/accounts'?{accounts}:path==='/api/domains'?{domains:[]}:account?{account:{...account,editable:true,canForwardEmail:false,deletable:id!=='primary'}}:{};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  const dark=size.width===390?'&dark=1':'';
  await page.goto(origin+'/?list=1'+dark);
  const active=page.locator('a[href="/accounts/primary"]'),disabled=page.locator('a[href="/accounts/target"]');
  await active.getByText(de['accounts.status.enabled'],{exact:true}).waitFor();await disabled.getByText(de['accounts.status.disabled'],{exact:true}).waitFor();
  const overflowing=await page.evaluate(()=>[...document.querySelectorAll('body *')].map(x=>({tag:x.tagName,cls:x.className,text:x.textContent?.slice(0,80),rect:x.getBoundingClientRect().toJSON()})).filter(x=>x.rect.right>innerWidth+1));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,JSON.stringify({size,overflowing}));
  if(size.width===390)await page.screenshot({path:'/tmp/mailflare-account-status-mobile.png'});
  await page.goto(origin+'/?details=1&id=target'+dark);
  const trigger=page.getByRole('button',{name:de['account.delete.button'],exact:true});await trigger.waitFor();
  const open=async()=>{await trigger.scrollIntoViewIfNeeded();await trigger.click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));};
  await open();let dialog=page.getByRole('dialog');const b=await dialog.boundingBox();assert(b.x>=15&&b.y>=15&&b.x+b.width<=size.width-15&&b.y+b.height<=size.height-15,JSON.stringify({size,b}));
  assert(await dialog.evaluate(el=>el.contains(document.activeElement)));await dialog.getByText(de['account.delete.keepAssets'],{exact:true}).waitFor();await dialog.getByText(de['account.delete.removePrivateData'],{exact:true}).waitFor();
  const confirmation=dialog.getByLabel(de['account.delete.confirmEmail']),submit=dialog.getByRole('button',{name:de['account.delete.button'],exact:true});assert(await submit.isDisabled());
  await confirmation.fill('wrong@example.test');assert(await submit.isDisabled());await confirmation.fill('target@example.test');assert(await submit.isEnabled());
  for(const button of await dialog.locator('form button').all())assert((await button.boundingBox()).height>=44,JSON.stringify(await button.evaluate(x=>({text:x.textContent,height:x.getBoundingClientRect().height,minHeight:getComputedStyle(x).minHeight,fontSize:getComputedStyle(x).fontSize,transform:getComputedStyle(x.closest('[role=dialog]')).transform}))));
  if(size.width===390)await page.screenshot({path:'/tmp/mailflare-account-delete-mobile.png'});
  await dialog.getByRole('button',{name:de['common.cancel'],exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(deletions.length,0);
  await open();assert.equal(await confirmation.inputValue(),'');await confirmation.fill('target@example.test');failDelete=true;await submit.click();await dialog.getByRole('alert').waitFor();assert.equal(await dialog.getByRole('alert').innerText(),'Testfehler: Konto bleibt erhalten');assert.equal(await page.evaluate(()=>window.navigatedPath),undefined);
  failDelete=false;pendingResolve={};await submit.click();await page.getByRole('button',{name:de['account.delete.deleting'],exact:true}).waitFor();assert(await confirmation.isDisabled());await page.keyboard.press('Escape');assert(await dialog.isVisible());pendingResolve.resolve();pendingResolve=null;
  await page.waitForFunction(()=>window.navigatedPath==='/accounts');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('[data-testid="mailboxes"]').textContent.includes('transferredbox'));assert.equal(await page.evaluate(()=>window.refreshCount),1);assert.deepEqual(deletions.at(-1),{path:'/api/accounts/target',body:{confirmEmail:'target@example.test'}});
  await page.goto(origin+'/?details=1&id=primary'+dark);await page.getByText(de['account.delete.primaryProtected'],{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:de['account.delete.button'],exact:true}).count(),0);
  await page.goto(origin+'/?activity=1'+dark);const row=page.locator('tr').filter({hasText:de['activity.accountDeleted']});await row.waitFor();await row.getByText('target@example.test',{exact:true}).waitFor();await row.getByText(de['activity.avatarCleanupPending'],{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport:size,statusBadges:true,confirmationAndCancel:true,retryAndPendingProtection:true,primaryProtected:true,transferredMailboxRefresh:true,deletionAuditVisible:true,noOverflow:true}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
