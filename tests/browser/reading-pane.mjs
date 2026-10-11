// Uses the actual list, split layout, preference control and resize handle.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-reading-browser-'));
const write=(name,value)=>writeFileSync(join(dir,name),value);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
write('mailbox.ts',`const mailbox={id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Owner',permission:'full_access'};export const useSelectedMailbox=()=>({selectedMailbox:mailbox,mailboxes:[mailbox],isLoading:false});`);
write('sidebar.ts',`const setForcedMinimal=(value)=>{window.__forcedMinimal=value};export const useSidebar=()=>({userId:'owner',setForcedMinimal});`);
write('assistant.ts','export const useAssistantOpen=()=>false;');
write('search.ts','export const useMailSearch=()=>({query:""});');
write('loading.ts','export const usePageLoading=()=>{};');
write('link.tsx','export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>;}');
write('navigation.ts',`import {useSyncExternalStore} from 'react';const subscribe=(listener)=>{window.addEventListener('fixture:navigate',listener);return ()=>window.removeEventListener('fixture:navigate',listener)};export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname);const router={push:(href)=>{history.pushState({},'',href);window.dispatchEvent(new Event('fixture:navigate'))},refresh:()=>{}};export const useRouter=()=>router;`);
write('messages.ts',`const messages=Array.from({length:25},(_,i)=>({id:'msg-'+i,direction:'inbound',status:'received',category:'primary',read:true,starred:false,fromAddr:'sender'+i+'@example.test',toAddr:'owner@example.test',subject:'Nachricht '+i,textBody:'Sample message',snippet:'Sample message',labels:i===0?[{id:'source',name:'Aperturo',color:'#2563eb'},{id:'work',name:'Projektunterlagen und persönliche Dokumente',color:'#16a34a'},{id:'third',name:'Nachfassen',color:'#7c3aed'},{id:'fourth',name:'Wichtig',color:'#dc2626'}]:[],createdAt:'2026-10-11T12:00:00Z'}));export const useMessages=()=>({messages,isLoading:false,total:25,limit:25,updateMessages:()=>{}});`);
write('counts.ts','export const useMessageCounts=()=>({counts:{folders:{inbox:{total:25,unread:0}},customFolders:{},mailboxes:[]}});');
write('entry.tsx',`
 import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
 import {LanguageProvider} from '@/components/language-provider';import {MessageSplitLayout} from '@/components/messages/message-split-layout';import {MessageFolderPage} from '@/components/messages/message-folder-page';import {InboxReadingLayoutSettings} from '@/components/settings/inbox-reading-layout-settings';import {inboxFolderConfig} from '@/components/messages/message-folder-configs';import {useMessageListVisibility} from '@/components/messages/message-list-visibility';import {usePathname} from 'next/navigation';import de from '../../public/locales/de.json';
 function Content(){return usePathname()==='/inbox'?<MessageFolderPage config={inboxFolderConfig}/>:<Reader/>}
 function Reader(){const pathname=usePathname(),list=useMessageListVisibility();return <article data-testid="reader" style={{height:'100%',overflowY:'auto',padding:16}}><button onClick={list.toggle}>Liste ein-/ausblenden</button><h1>Geöffnete E-Mail {pathname.split('/').at(-1)}</h1>{Array.from({length:35},(_,i)=><p key={i} style={{marginBottom:16}}>Absatz {i}: Dieser Inhalt lässt sich unabhängig von der Nachrichtenliste lesen.</p>)}</article>}
 createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}><div style={{height:'100dvh',display:'flex'}}><aside className="hidden lg:block" style={{width:240,flexShrink:0}}>Posteingang</aside><main style={{display:'flex',flexDirection:'column',flex:1,minWidth:0,minHeight:0}}><header style={{padding:8}}><InboxReadingLayoutSettings/></header><div style={{flex:1,minHeight:0}}><MessageSplitLayout config={inboxFolderConfig}><Content/></MessageSplitLayout></div></main></div></LanguageProvider></QueryClientProvider>);
`);
const cssDir=join(root,'dist/client/_next/static/css');
const css=readFileSync(join(cssDir,readdirSync(cssDir).find(name=>name.startsWith('index.')&&name.endsWith('.css'))));
let browser,server;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src'),'@/components/mailbox-provider':join(dir,'mailbox.ts'),'@/components/sidebar-state':join(dir,'sidebar.ts'),'@/components/agent/assistant-open-state':join(dir,'assistant.ts'),'@/components/mail-search/mail-search-context':join(dir,'search.ts'),'@/components/page-loading':join(dir,'loading.ts'),'@/hooks/use-messages':join(dir,'messages.ts'),'@/hooks/use-message-counts':join(dir,'counts.ts'),'next/link':join(dir,'link.tsx'),'next/navigation':join(dir,'navigation.ts')},define:{'process.env.NODE_ENV':'"production"'}});
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname,asset=assets[path]||(!path.startsWith('/api/')&&!path.endsWith('.js')&&!path.endsWith('.css')?assets['/']:null);res.writeHead(asset?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(asset||'Not found');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.MAILFLARE_CHROMIUM_EXECUTABLE?{executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 for(const viewport of [{width:1440,height:900},{width:1024,height:768},{width:320,height:700},{width:390,height:844},{width:430,height:932},{width:844,height:390}]){
  const page=await browser.newPage({viewport,hasTouch:viewport.width<1024}),errors=[];page.on('pageerror',error=>errors.push(error.stack));
  await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({messages:[],folders:[],ok:true})}));
  const dark=viewport.width===390;
  if(dark)await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('dark'),{once:true}));
  await page.goto(origin+'/inbox');
  const labelled=page.locator('a[href="/inbox/msg-0"]'),chips=labelled.locator('[data-message-labels]');
  await chips.waitFor();assert.equal(await chips.getByText('Aperturo',{exact:true}).count(),1);assert.equal(await chips.getByText('+2',{exact:true}).count(),1);
  assert(await chips.getByText('Aperturo',{exact:true}).evaluate(el=>el.clientWidth>=el.scrollWidth),'the short source label stays readable');
  assert((await chips.getAttribute('aria-label')).includes('Nachfassen, Wichtig'));
  const cb=await chips.boundingBox(),subject=await labelled.getByText('Nachricht 0',{exact:true}).boundingBox();
  assert(cb.x>=0&&cb.x+cb.width<=viewport.width);assert(cb.width>30&&cb.height>=20);assert(subject.width>=40&&subject.x>=cb.x+cb.width-1);
  assert.equal(await chips.locator('[aria-hidden="true"]').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(37, 99, 235)');
  assert.equal(await page.locator('a[href="/inbox/msg-1"] [data-message-labels]').count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'labelled inbox has no horizontal overflow');
  if(viewport.width===390||viewport.width===1440)await page.screenshot({path:'/tmp/mailflare-inbox-labels-'+(viewport.width===390?'mobile':'desktop')+'.png'});
  await page.goto(origin+'/inbox/msg-0');const layout=page.locator('[data-reading-layout]'),reader=page.getByTestId('reader'),list=layout.locator(':scope > aside');
	await page.waitForFunction(()=>document.querySelector('[data-reading-layout]')?.getAttribute('data-reading-layout')==='bottom');await page.waitForTimeout(350);
  if(viewport.width>=1024){
   const lb=await list.boundingBox(),rb=await reader.boundingBox();assert(lb.width>viewport.width-242&&rb.y>=lb.y+lb.height-1,{lb,rb});assert(Math.abs(rb.x-lb.x)<1);assert(rb.height>=180);
   const separator=page.getByRole('separator',{name:de['list.resizeHeight'],exact:true});assert.equal(await separator.getAttribute('aria-orientation'),'horizontal');
   await separator.focus();await page.keyboard.press('ArrowDown');await page.waitForTimeout(350);assert((await list.boundingBox()).height>lb.height);
   const sb=await separator.boundingBox();await page.mouse.move(sb.x+sb.width/2,sb.y+sb.height/2);await page.mouse.down();await page.mouse.move(sb.x+sb.width/2,sb.y+sb.height/2+55,{steps:5});await page.mouse.up();await page.waitForTimeout(350);
   const resized=(await list.boundingBox()).height;assert(resized>lb.height+30);assert.equal(await page.evaluate(()=>localStorage.getItem('mailflare-column-width:message-list-height:owner')),String(resized));
   await reader.evaluate(el=>el.scrollTop=180);assert.equal(await list.locator('.overflow-y-auto').last().evaluate(el=>el.scrollTop),0);
   await list.locator('a[href="/inbox/msg-1"]').getByText('Nachricht 1',{exact:true}).click();await page.getByRole('heading',{name:'Geöffnete E-Mail msg-1',exact:true}).waitFor();assert.equal((await list.boundingBox()).height,resized);
   if(viewport.width===1440)await page.screenshot({path:'/tmp/mailflare-reading-pane-desktop.png'});
   await reader.getByRole('button',{name:'Liste ein-/ausblenden'}).click();await page.waitForTimeout(350);assert.equal(await list.getAttribute('aria-hidden'),'true');assert((await reader.boundingBox()).height>rb.height);
   await reader.getByRole('button',{name:'Liste ein-/ausblenden'}).click();await page.waitForTimeout(350);
   await page.getByLabel(de['settings.reading.title'],{exact:true}).selectOption('right');await page.waitForTimeout(350);const rightList=await list.boundingBox(),rightReader=await reader.boundingBox();assert(rightReader.x>=rightList.x+rightList.width-1);assert(Math.abs(rightReader.y-rightList.y)<1);assert(await list.locator('[data-message-labels]').first().isVisible());
   await page.reload();await page.waitForTimeout(350);assert.equal(await layout.getAttribute('data-reading-layout'),'right');
   await page.getByLabel(de['settings.reading.title'],{exact:true}).selectOption('bottom');await page.waitForTimeout(350);
  }else{
   assert.equal(await list.isVisible(),false);const rb=await reader.boundingBox();assert(rb.width>=viewport.width-1);assert(rb.y+rb.height<=viewport.height+1);assert(rb.height>170);
  }
  await page.getByLabel(de['settings.reading.title'],{exact:true}).selectOption('off');await page.waitForTimeout(350);assert.equal(await layout.locator(':scope > aside').count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page overflow');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({viewport,below:viewport.width>=1024,mobileFullscreen:viewport.width<1024,layoutPreference:true,visibleAssignedLabels:true,theme:dark?'dark':'light',resizing:viewport.width>=1024,noOverflow:true}));await page.close();
 }
 const page=await browser.newPage({viewport:{width:1440,height:900}});await page.addInitScript(()=>localStorage.setItem('mailflare-two-column-reading','off'));await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:'{"messages":[]}'}));await page.goto(origin+'/inbox/msg-0');await page.waitForFunction(()=>document.querySelector('[data-reading-layout]')?.getAttribute('data-reading-layout')==='off');console.log(JSON.stringify({legacyDisabledPreferencePreserved:true}));await page.close();
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
