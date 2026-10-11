// Run after `npm run build`. Point MAILFLARE_PLAYWRIGHT_MODULE and optionally
// MAILFLARE_CHROMIUM_EXECUTABLE to the installed browser tooling when needed.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const browserName=process.env.MAILFLARE_BROWSER || 'chromium';
assert(['chromium','firefox','webkit'].includes(browserName),'unsupported browser engine');
const browserType=(await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright'))[browserName];
const root=process.cwd();
const dir=mkdtempSync(join(root,'node_modules','mailflare-menu-browser-'));
const baselineRef=process.argv.find(arg=>arg.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length);
const write=(name,value)=>writeFileSync(join(dir,name),value);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
write('compose.ts','export const useCompose=()=>({openDraftComposer:()=>{}});');
write('shortcuts.ts','export const useHotkeys=()=>{};export const useShortcuts=()=>({shortcutsEnabled:false});');
write('mailbox.ts',`export const useSelectedMailbox=()=>({selectedMailbox:{id:'box',userId:'owner',localPart:'owner',hostname:'example.test',displayName:'Owner',type:'personal',permission:'full_access',hasAvatar:false},setSelectedMailbox:()=>{},mailboxes:[],isLoading:false});`);
write('link.tsx','export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>;}');
write('navigation.ts','export const usePathname=()=>"/inbox";export const useRouter=()=>({push:()=>{},refresh:()=>{}});');
write('entry.tsx',`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
 import {LanguageProvider} from '@/components/language-provider';
 import {MailboxSelector} from '@/components/mailbox-selector';
 import {MessageActions} from '@/components/message-actions/message-actions';
 import {ThreadMessageActions} from '@/components/messages/thread-message-actions';
 import de from '../../public/locales/de.json';
 const message={id:'msg',mailboxId:'box',direction:'inbound',status:new URLSearchParams(location.search).get('status')||'received',fromAddr:'sender@example.test',toAddr:'owner@example.test',ccAddr:'colleague@example.test',read:true,starred:false,subject:'Test message',textBody:'Hello',htmlBody:null,createdAt:'2026-10-11T12:00:00Z',providerMessageId:null,references:null,threadId:null};
 if(new URLSearchParams(location.search).has('dark'))document.documentElement.classList.add('dark');
 createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}><header style={{height:64,display:'flex',justifyContent:'flex-end',paddingRight:56}}><MailboxSelector initialUser={{id:'owner',name:'Owner',email:'owner@example.test',role:'user',hasAvatar:false}}/></header><main className="bg-white text-neutral-700" style={{minHeight:'180vh',padding:'100px 24px 24px'}}><section data-testid="header-actions" style={{overflow:'hidden',maxWidth:'100%'}}><MessageActions messageId="msg" mailboxId="box" senderAddress={message.fromAddr} direction="inbound" status={message.status} read={true} message={message} messageMeta={message} ownAddress="owner@example.test" ownAddresses={['owner@example.test']} bodyText="Hello"/></section><p style={{height:'55vh'}}>Message content</p><section data-testid="thread-actions" style={{display:'flex',justifyContent:'flex-end',overflow:'hidden'}}><ThreadMessageActions message={{...message,id:'thread-message',fromAddr:'Reply sender <reply@example.test>'}} mailboxId="box" ownAddress="owner@example.test" ownAddresses={['owner@example.test']}/></section></main></LanguageProvider></QueryClientProvider>);
`);
const cssDir=join(root,'dist/client/_next/static/css');
const css=readFileSync(join(cssDir,readdirSync(cssDir).find(name=>name.startsWith('index.')&&name.endsWith('.css'))));
let server,browser;
try {
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src'),'@/components/compose/compose-context':join(dir,'compose.ts'),'@/components/shortcuts':join(dir,'shortcuts.ts'),'@/components/mailbox-provider':join(dir,'mailbox.ts'),'next/link':join(dir,'link.tsx'),'next/navigation':join(dir,'navigation.ts')},define:{'process.env.NODE_ENV':'"production"'},plugins:baselineRef?[{name:'baseline',setup(b){b.onLoad({filter:/\/(message-actions|thread-message-actions|mailbox-selector)\.tsx$/},args=>({contents:execFileSync('git',['show',baselineRef+':'+args.path.slice(root.length+1)],{encoding:'utf8'}),loader:'tsx'}));}}]:[]});
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const content=assets[path];res.writeHead(content?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(content||'Not found');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserType.launch({headless:true,...(browserName==='chromium'&&process.env.MAILFLARE_CHROMIUM_EXECUTABLE?{executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE}:{}),...(browserName==='chromium'?{args:['--no-sandbox']}: {})});
 const sizes=baselineRef?[{width:390,height:844}]:[{width:320,height:700},{width:375,height:667},{width:390,height:844},{width:430,height:932},{width:768,height:1024},{width:820,height:1180},{width:844,height:390},{width:1440,height:900}];
 for(const size of sizes){
  const mobile=size.width<768,touch=size.width<1024;
  const page=await browser.newPage({viewport:size,hasTouch:touch});
  const errors=[],actions=[],filters=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{const request=route.request(),path=new URL(request.url()).pathname;if(path==='/api/messages/bulk')actions.push(request.postDataJSON());if(path==='/api/auth/accounts')return route.fulfill({contentType:'application/json',body:JSON.stringify({accounts:[]})});if(path==='/api/messages/counts')return route.fulfill({contentType:'application/json',body:JSON.stringify({counts:{folders:{},customFolders:{},mailboxes:[]}})});if(path==='/api/folders')return route.fulfill({contentType:'application/json',body:JSON.stringify({folders:[{id:'work',name:'Work'},{id:'follow',name:'Follow up'}]})});if(path==='/api/routing-rules'){if(request.method()==='POST'){const input=request.postDataJSON();if(input.forwardTo==='unverified@example.net')return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'forwarding_unverified'})});filters.push(input);return route.fulfill({contentType:'application/json',body:JSON.stringify({id:'new-filter'})});}return route.fulfill({contentType:'application/json',body:JSON.stringify({rules:[]})});}return route.fulfill({contentType:path.endsWith('/source')?'message/rfc822':'application/json',body:path.endsWith('/source')?'From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Test\r\n\r\nHello':JSON.stringify({ok:true})});});
  await page.goto(origin+(size.width===390?'/?dark=1':''));
  const trigger=page.getByTestId('header-actions').getByRole('button',{name:de['common.moreActions'],exact:true});
  const open=async button=>{if(mobile)await button.tap();else await button.click();};
  const accountTrigger=page.getByRole('button',{name:de['account.openMenu'],exact:true});await open(accountTrigger);const accountPanel=page.locator('header .absolute.right-0');await accountPanel.waitFor();const accountBounds=await accountPanel.boundingBox();if(baselineRef)console.log(JSON.stringify({baselineRef,viewport:size,accountBounds,accountClipping:accountBounds.x<0}));else assert(accountBounds.x>=11&&accountBounds.y>=0&&accountBounds.x+accountBounds.width<=size.width-11&&accountBounds.y+accountBounds.height<=size.height-11,JSON.stringify({accountBounds,viewport:size}));await accountPanel.getByRole('link',{name:de['account.settings'],exact:true}).scrollIntoViewIfNeeded();if(baselineRef)await open(accountTrigger);else await page.keyboard.press('Escape');await accountPanel.waitFor({state:'hidden'});
  await open(trigger);
  if(baselineRef){const bounds=await page.getByTestId('header-actions').locator('.absolute.right-0').boundingBox();assert(bounds.x<0,'baseline should reproduce left clipping');console.log(JSON.stringify({baselineRef,viewport:size,menuBounds:bounds,clippingReproduced:true}));await page.close();continue;}
  const menu=page.getByRole('menu');
  const checkBounds=async()=>{await menu.waitFor();await page.waitForTimeout(80);const b=await menu.boundingBox();assert(b.x>=11&&b.y>=11&&b.x+b.width<=size.width-11&&b.y+b.height<=size.height-11,JSON.stringify({viewport:size,bounds:b}));assert(await menu.evaluate(el=>el.parentElement.parentElement===document.body||document.body.contains(el)&&!el.closest('section')),'menu must escape clipping ancestors');return b;};
  await checkBounds();
  // Additional filter actions may require scrolling even on a tall phone.
  if(mobile&&await menu.evaluate(el=>el.scrollHeight>el.clientHeight)){
   const bounds=await menu.boundingBox();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.wheel(0,200);await page.waitForTimeout(80);assert(await menu.evaluate(el=>el.scrollTop>0),'overflowing menus must scroll to additional actions');await menu.evaluate(el=>el.scrollTop=0);
  }
  const items=menu.getByRole('menuitem');assert(await items.count()>=7);
  for(const item of await items.all()){
   await item.scrollIntoViewIfNeeded();const itemBounds=await item.boundingBox(),menuBounds=await menu.boundingBox();assert(itemBounds.x>=menuBounds.x&&itemBounds.x+itemBounds.width<=menuBounds.x+menuBounds.width);assert(itemBounds.y>=menuBounds.y&&itemBounds.y+itemBounds.height<=menuBounds.y+menuBounds.height);
   if(touch){assert(itemBounds.height>=44);assert.equal(await item.evaluate(el=>getComputedStyle(el).fontSize),'16px');}
   assert(await item.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const box=el.getBoundingClientRect();return [...range.getClientRects()].every(rect=>rect.left>=box.left-1&&rect.right<=box.right+1);}),await item.textContent());
  }
  if(size.width===390)await page.screenshot({path:'/tmp/mailflare-message-menu-mobile.png'});
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});await page.waitForFunction(el=>el===document.activeElement,await trigger.elementHandle());
  await open(trigger);await checkBounds();await page.mouse.click(size.width-2,size.height-2);await menu.waitFor({state:'hidden'});
  await open(trigger);await menu.getByRole('menuitem',{name:de[mobile?'common.markUnread':'navigation.archived'],exact:true}).click();await menu.waitFor({state:'hidden'});await page.waitForTimeout(80);assert.deepEqual(actions,[{messageIds:['msg'],action:mobile?'unread':'archive'}]);
  await open(trigger);await menu.getByRole('menuitem',{name:de['message.showOriginal'],exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();await page.waitForTimeout(80);assert(await dialog.evaluate(el=>el.contains(document.activeElement)),'source dialog must receive focus');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await open(trigger);await menu.getByRole('menuitem',{name:de['rules.filterSimilar'],exact:true}).click();await dialog.waitFor();
  const value=dialog.getByLabel(de['rules.valueLabel'],{exact:true});assert.equal(await value.inputValue(),'sender@example.test');
  await dialog.getByRole('button',{name:de['rules.senderDomain'],exact:true}).click();assert.equal(await value.inputValue(),'@example.test');
  await dialog.getByRole('button',{name:de['rules.exactSender'],exact:true}).click();await dialog.getByRole('button',{name:de['rules.addSubject'],exact:true}).click();
  await dialog.getByRole('button',{name:de['rules.chooseActions'],exact:true}).click();
  await dialog.getByLabel(de['smart.category'],{exact:true}).selectOption('promotions');
  await dialog.getByRole('checkbox',{name:'Work',exact:true}).check();await dialog.getByRole('checkbox',{name:'Follow up',exact:true}).check();await dialog.getByRole('checkbox',{name:de['smart.skip'],exact:true}).check();
  if(size.width===390){await dialog.getByRole('checkbox',{name:de['rules.forward'],exact:true}).check();const destination=dialog.getByLabel(de['settings.forwarding.destination'],{exact:false});await destination.fill('unverified@example.net');await dialog.getByRole('button',{name:de['rules.createFilter'],exact:true}).click();await dialog.getByRole('alert').waitFor();assert.match(await dialog.getByRole('alert').textContent(),/Cloudflare/);assert.equal(filters.length,0);await destination.fill('forward@example.net');await dialog.getByRole('button',{name:de['rules.createFilter'],exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/mailflare-message-filter-mobile.png'});}
  await dialog.getByRole('button',{name:de['rules.createFilter'],exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(filters.length,1);assert.equal(filters[0].sourceMessageId,'msg');assert.equal(filters[0].mailboxId,'box');assert.deepEqual(filters[0].labelIds,['work','follow']);assert.equal(filters[0].category,'promotions');assert.equal(filters[0].skipInbox,true);assert.deepEqual(filters[0].conditions,[{field:'sender',operator:'exact',value:'sender@example.test',negate:false},{field:'title',operator:'contains',value:'Test message',negate:false}]);
  const threadTrigger=page.getByTestId('thread-actions').getByRole('button',{name:de['common.moreActions'],exact:true});await threadTrigger.scrollIntoViewIfNeeded();await open(threadTrigger);await checkBounds();const final=menu.getByRole('menuitem').last();await final.scrollIntoViewIfNeeded();await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('role')),'menuitem');await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
  await open(threadTrigger);await menu.getByRole('menuitem',{name:de['rules.filterSimilar'],exact:true}).click();await dialog.waitFor();assert.equal(await dialog.getByLabel(de['rules.valueLabel'],{exact:true}).inputValue(),'reply@example.test');await dialog.getByRole('button',{name:de['common.cancel'],exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(filters.length,1);
  // Keep an open menu within the available area when orientation/viewport changes.
  await trigger.scrollIntoViewIfNeeded();await open(trigger);await checkBounds();const resized={width:size.height,height:size.width};await page.setViewportSize(resized);await page.waitForTimeout(100);const b=await menu.boundingBox();assert(b.x>=11&&b.y>=11&&b.x+b.width<=resized.width-11&&b.y+b.height<=resized.height-11);await page.keyboard.press('Escape');
  if(mobile){await page.setViewportSize(size);await page.goto(origin+'/?status=archived');const archivedTrigger=page.getByTestId('header-actions').getByRole('button',{name:de['common.moreActions'],exact:true});await open(archivedTrigger);const archivedItem=menu.getByRole('menuitem',{name:de['common.archive'],exact:true});assert.equal(await archivedItem.getAttribute('aria-disabled'),'true');await archivedItem.click({force:true});assert.equal(actions.length,1);await page.keyboard.press('Escape');}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport:size,theme:size.width===390?'dark':'light',headerAndThreadMenus:true,allItemsReachable:true,touchTargets:touch?'44px':'desktop',dismissalAndFocus:true,singleAction:true,orientationChange:true}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
