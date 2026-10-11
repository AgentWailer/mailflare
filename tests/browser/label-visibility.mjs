// Real sidebar, label settings and query cache; API responses and route boundaries are controlled.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const browserName=process.env.MAILFLARE_BROWSER||'chromium';
assert(['chromium','firefox','webkit'].includes(browserName));
const browserType=(await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright'))[browserName];
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-visibility-browser-'));
const write=(name,value)=>writeFileSync(join(dir,name),value);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
write('compose.ts','export const useCompose=()=>({openComposer:()=>{}});');
write('mailbox.ts',`import {useSyncExternalStore} from 'react';const listen=fn=>{window.addEventListener('fixture:mailbox',fn);return ()=>window.removeEventListener('fixture:mailbox',fn)};export const useSelectedMailbox=()=>{const id=useSyncExternalStore(listen,()=>window.__box||'box');return {selectedMailbox:{id,localPart:id,hostname:'example.test',permission:'full_access'},mailboxes:[],isLoading:false}};`);
write('sidebar.ts',`export const useSidebar=()=>({minimal:false,mobile:innerWidth<768,mobileOpen:true,toggle:()=>{}});`);
write('chrome.tsx',`export const SidebarHeader=()=> <div>Mailflare</div>;export const SidebarFooter=()=>null;`);
write('link.tsx',`export default function Link({href,children,prefetch,scroll,...props}){return <a href={href} {...props}>{children}</a>;}`);
write('navigation.ts',`const router={replace:()=>{},push:()=>{},prefetch:()=>{},refresh:()=>{}};export const usePathname=()=>'/inbox';export const useRouter=()=>router;`);
write('entry.tsx',`
 import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
 import {LanguageProvider} from '@/components/language-provider';import {DashboardNav} from '@/components/dashboard-nav';import {LabelVisibilitySettings} from '@/components/settings/label-visibility-settings';import de from '../../public/locales/de.json';
 function App(){const [settings,setSettings]=React.useState(false);return <><button data-fixture-toggle onClick={()=>setSettings(!settings)}>Ansicht wechseln</button><div data-sidebar style={{width:'min(300px,100vw)',height:'calc(100dvh - 48px)',display:settings?'none':'block'}}><DashboardNav/></div><div data-settings style={{padding:16,maxWidth:700,display:settings?'block':'none'}}><LabelVisibilitySettings/></div></>}
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});window.__queryClient=client;
 createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><LanguageProvider initialLocale="de" initialMessages={de}><App/></LanguageProvider></QueryClientProvider>);
`);
let browser,server;
try {
 const aliases={'compose-context':'compose.ts','mailbox-provider':'mailbox.ts','sidebar-state':'sidebar.ts','sidebar-header':'chrome.tsx','sidebar-footer':'chrome.tsx'};
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src'),'next/link':join(dir,'link.tsx'),'next/navigation':join(dir,'navigation.ts')},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-contexts',setup(b){b.onResolve({filter:/(?:^|\/)(compose-context|mailbox-provider|sidebar-state|sidebar-header|sidebar-footer)$/},args=>({path:join(dir,aliases[args.path.split('/').at(-1)])}));}}],logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(name=>name.startsWith('index.')&&name.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserType.launch({headless:true,...(browserName==='chromium'&&process.env.MAILFLARE_CHROMIUM_EXECUTABLE?{executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE}:{}),...(browserName==='chromium'?{args:['--no-sandbox']}:{})});
 for(const viewport of [{width:320,height:700},{width:390,height:844},{width:768,height:1024},{width:820,height:1180},{width:1024,height:768},{width:1440,height:900}]) {
  const page=await browser.newPage({viewport,hasTouch:viewport.width<=1024}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  const labels=Array.from({length:8},(_,i)=>({id:'label-'+i,name:i===7?'Ein sehr langes Label für persönliche Dokumente und Projekte':'Label '+i,color:'#2563eb'}));
  const hidden={box:[],other:[]};let fail=false,hold=false,release,requestHeld,failCreate=false;
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());let body={};
   if(url.pathname==='/api/settings/labels') {
    const input=req.method()==='PATCH'?req.postDataJSON():{mailboxId:url.searchParams.get('mailboxId')};
    if(req.method()==='PATCH') {
     if(hold)await new Promise(resolve=>{release=resolve;requestHeld?.();});
     if(fail)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Temporary failure"}'});
     hidden[input.mailboxId]=hidden[input.mailboxId].filter(id=>id!==input.labelId);if(!input.visible)hidden[input.mailboxId].push(input.labelId);
    }
    body={hiddenLabelIds:hidden[input.mailboxId]};
   } else if(url.pathname==='/api/folders'&&req.method()==='POST'){if(failCreate)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Temporary failure"}'});body={id:'created',...req.postDataJSON()};labels.push(body);} else if(url.pathname==='/api/folders') body={folders:url.searchParams.get('mailboxId')==='other'?[{id:'other-label',name:'Anderes Postfach',color:'#16a34a'}]:labels};
   else if(url.pathname==='/api/messages/counts') body={counts:{folders:Object.fromEntries(['inbox','promotions','social','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'].map(key=>[key,{total:0,unread:0}])),customFolders:{},mailboxes:[]}};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.addInitScript(()=>{if(innerWidth===390)document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('dark'),{once:true});localStorage.setItem('mailflare:nav:more-open','false');localStorage.setItem('mailflare:nav:folders-open','false');localStorage.setItem('mailflare:nav:folders-section-open','false');});
  await page.goto(origin);const sidebar=page.locator('[data-sidebar]'),settings=page.locator('[data-settings]');
  await sidebar.locator('a[href="/folders/label-7"]').waitFor();
  for(const path of ['/inbox','/promotions','/social','/starred','/all','/snoozed','/sent','/scheduled','/drafts','/archived','/spam','/trash'])assert.equal(await sidebar.locator(`a[href="${path}"]`).count(),1,'every mail area is listed, even when empty');
  assert.equal(await sidebar.getByRole('button',{name:de['navigation.more'],exact:true}).count(),0);assert.equal(await sidebar.locator('[data-reorder-list="folders"]').count(),8);
  const last=sidebar.locator('a[href="/folders/label-7"]');await last.scrollIntoViewIfNeeded();assert(await last.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}),'the last label remains reachable in the sidebar scroller');
  await page.locator('[data-fixture-toggle]').click();await settings.getByRole('switch').first().waitFor();
  const toggle=settings.getByRole('switch',{name:de['labels.visibility.toggle'].replace('{name}','Label 0'),exact:true});
  if(viewport.width===390)await page.screenshot({path:'/tmp/mailflare-label-visibility-mobile.png'});assert.equal(await toggle.getAttribute('aria-checked'),'true');const b=await toggle.boundingBox();assert(b.width>=44&&b.height>=44);
  fail=true;await toggle.click();await settings.getByRole('alert').waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'true');assert.equal(await sidebar.locator('a[href="/folders/label-0"]').count(),1);
  fail=false;hold=true;const held=new Promise(resolve=>requestHeld=resolve);await toggle.click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.disabled);assert.equal(await toggle.getAttribute('disabled'),'');assert.equal(await sidebar.locator('a[href="/folders/label-0"]').count(),1);await held;release();hold=false;
  await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='false');assert.equal(await sidebar.locator('a[href="/folders/label-0"]').count(),0);
  await toggle.click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='true');assert.equal(await sidebar.locator('a[href="/folders/label-0"]').count(),1);
  await toggle.click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='false');
  await page.reload();await sidebar.locator('a[href="/folders/label-7"]').waitFor();await page.waitForFunction(()=>!document.querySelector('a[href="/folders/label-0"]'));
  await page.evaluate(()=>{window.__box='other';window.dispatchEvent(new Event('fixture:mailbox'));});assert.equal(await sidebar.locator('a[href="/folders/label-7"]').count(),0,'changing mailboxes hides stale labels immediately');await sidebar.locator('a[href="/folders/other-label"]').waitFor();
  await page.evaluate(()=>{window.__box='box';window.dispatchEvent(new Event('fixture:mailbox'));});await sidebar.locator('a[href="/folders/label-7"]').waitFor();assert.equal(await sidebar.locator('a[href="/folders/label-0"]').count(),0);
  hidden.box=[];await page.locator('[data-fixture-toggle]').click();await page.evaluate(()=>window.__queryClient.invalidateQueries({queryKey:['label-visibility','box']}));await settings.getByRole('switch').first().waitFor();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='true');assert.equal(await sidebar.locator('a[href="/folders/label-0"]').count(),1,'fresh server preferences restore another device\'s changes');
  for(const sw of await settings.getByRole('switch').all()){await sw.click();await page.waitForFunction(el=>el.getAttribute('aria-checked')==='false',await sw.elementHandle());await page.waitForFunction(()=>[...document.querySelectorAll('[role=switch]')].every(el=>!el.disabled));assert.equal(await sw.getAttribute('aria-checked'),'false');}
  assert.equal(await sidebar.locator('[data-reorder-list=folders]').count(),0);assert.equal(await sidebar.locator('a[href="/settings/inbox#labels"]').getByText(de['labels.visibility.allHidden'],{exact:true}).count(),1);
  await settings.getByRole('switch').first().click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='true');assert.equal(await sidebar.locator('a[href="/folders/label-0"]').count(),1);
  await page.locator('[data-fixture-toggle]').click();await sidebar.getByRole('button',{name:de['navigation.createFolder'],exact:true}).click();const dialog=page.getByRole('dialog'),name=dialog.getByRole('textbox',{name:de['navigation.folderName'],exact:true});await name.fill('Ein neues Label');failCreate=true;await dialog.getByRole('button',{name:de['navigation.createFolder'],exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(await name.inputValue(),'Ein neues Label');failCreate=false;await dialog.getByRole('button',{name:de['navigation.createFolder'],exact:true}).click();await dialog.waitFor({state:'hidden'});await sidebar.locator('a[href="/folders/created"]').waitFor();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({viewport,allAreasAndLabelsListed:true,visibilitySaveAndRetry:true,allHiddenRecoverable:true,createRetryKeepsInput:true,pendingProtection:true,persistence:true,mailboxScope:true,noOverflow:true}));await page.close();
 }
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
