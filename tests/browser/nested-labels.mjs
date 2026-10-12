// Real sidebar, label settings and query cache; API responses and route boundaries are controlled.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const browserName=process.env.MAILFLARE_BROWSER||'chromium';
assert(['chromium','firefox','webkit'].includes(browserName));
const browserType=(await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright'))[browserName];
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-nested-browser-'));
const write=(name,value)=>writeFileSync(join(dir,name),value);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
write('compose.ts','export const useCompose=()=>({openComposer:()=>{}});');
write('mailbox.ts',`import {useSyncExternalStore} from 'react';const listen=fn=>{window.addEventListener('fixture:mailbox',fn);return ()=>window.removeEventListener('fixture:mailbox',fn)};export const useSelectedMailbox=()=>{const id=useSyncExternalStore(listen,()=>window.__box||'box');return {selectedMailbox:{id,localPart:id,hostname:'example.test',permission:window.__readOnly?'read_only':'full_access'},mailboxes:[],isLoading:false}};`);
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
  let labels=[{id:'projects',name:'Projekte',color:'#2563eb',parentId:null},{id:'client',name:'Kunde',color:'#16a34a',parentId:'projects'},{id:'invoices',name:'Rechnungen',color:'#2563eb',parentId:'client'},{id:'personal',name:'Privat',color:'#ef4444',parentId:'projects'},{id:'notes',name:'Notizen',color:'#2563eb',parentId:null}];
  let hidden=[],failMove=false;const writes=[];
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());let body={};
   if(url.pathname==='/api/settings/labels') {
    if(req.method()==='PATCH'){const input=req.postDataJSON();hidden=hidden.filter(id=>id!==input.labelId);if(!input.visible)hidden.push(input.labelId);}
    body={hiddenLabelIds:hidden};
   } else if(url.pathname.startsWith('/api/folders/')&&req.method()==='PATCH') {
    if(failMove)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Temporary failure"}'});
    const input=req.postDataJSON(),id=url.pathname.split('/').at(-1);writes.push({id,...input});labels=labels.map(x=>x.id===id?{...x,parentId:input.parentId}:x);body={ok:true};
   } else if(url.pathname.startsWith('/api/folders/')&&req.method()==='DELETE') {
    const id=url.pathname.split('/').at(-1);labels=labels.filter(x=>x.id!==id).map(x=>x.parentId===id?{...x,parentId:null}:x);body={ok:true};
   } else if(url.pathname==='/api/folders'&&req.method()==='POST') {body={id:'created',...req.postDataJSON()};writes.push(body);labels.push(body);}
   else if(url.pathname==='/api/folders')body={folders:labels};
   else if(url.pathname==='/api/messages/counts')body={counts:{folders:Object.fromEntries(['inbox','promotions','social','invoices','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'].map(key=>[key,{total:0,unread:0}])),customFolders:{},mailboxes:[]}};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.addInitScript(()=>{if(innerWidth===390)document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('dark'),{once:true});});
  await page.goto(origin);const sidebar=page.locator('[data-sidebar]'),settings=page.locator('[data-settings]');
  const link=id=>sidebar.locator(`a[href="/folders/${id}"]`), row=id=>sidebar.locator(`[data-reorder-id="${id}"]`);
  await link('invoices').waitFor();assert.equal(await sidebar.locator('[data-reorder-list=folders]').count(),5);
  // Move the parent past another root label without detaching any descendants.
  const rootScope='mailflare:nav:layout:folders:box';const rootOrder=()=>sidebar.locator(`[data-reorder-scope="${rootScope}"][data-reorder-id]`).evaluateAll(nodes=>nodes.map(x=>x.dataset.reorderId));
  const parentGrip=link('projects');await parentGrip.scrollIntoViewIfNeeded();await link('notes').scrollIntoViewIfNeeded();await parentGrip.scrollIntoViewIfNeeded();
  const start=await parentGrip.boundingBox();await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();await page.waitForTimeout(420);await page.locator('[data-reorder-ghost]').waitFor();
  // Autoscroll until the following root is reachable, then release below it.
  let target=await row('notes').boundingBox();if(target.y+target.height>viewport.height){await page.mouse.move(start.x+start.width/2,viewport.height-12);await page.waitForTimeout(900);target=await row('notes').boundingBox();}
  await page.mouse.move(start.x+start.width/2,Math.min(viewport.height-12,target.y+target.height-2));await page.mouse.up();await page.locator('[data-reorder-ghost]').waitFor({state:'detached'});assert.deepEqual(await rootOrder(),['notes','projects']);assert.equal(await link('invoices').count(),1);assert.equal(labels.find(x=>x.id==='client').parentId,'projects');assert.equal(labels.find(x=>x.id==='invoices').parentId,'client');
  await row('projects').getByRole('button',{name:de['labels.actions'].replace('{name}','Projekte'),exact:true}).click();await page.getByRole('menuitem',{name:de['labels.moveUp'],exact:true}).click();assert.deepEqual(await rootOrder(),['projects','notes']);
  const expand=sidebar.getByRole('button',{name:de['labels.collapse'].replace('{name}','Projekte'),exact:true});await expand.scrollIntoViewIfNeeded();
  if(viewport.width<=1024){const b=await expand.boundingBox();assert(b.height>=44&&b.width>=44,'group toggles must remain usable on touch screens');}
  const projectsX=(await link('projects').boundingBox()).x,invoicesX=(await link('invoices').boundingBox()).x;assert(invoicesX>projectsX,'sublabels are indented');
  await expand.click();await link('invoices').waitFor({state:'detached'});assert.equal(await link('notes').count(),1);await page.reload();await link('projects').waitFor();assert.equal(await link('client').count(),0,'collapse survives a page reload');
  await sidebar.getByRole('button',{name:de['labels.expand'].replace('{name}','Projekte'),exact:true}).click();await link('invoices').waitFor();
  await row('personal').getByRole('button',{name:de['labels.actions'].replace('{name}','Privat'),exact:true}).click();await page.getByRole('menuitem',{name:de['labels.moveUp'],exact:true}).click();
  const siblingOrder=await sidebar.locator('[data-reorder-scope="mailflare:nav:layout:folders:box:children:projects"]').evaluateAll(nodes=>nodes.filter(x=>x.dataset.reorderId).map(x=>x.dataset.reorderId));assert.deepEqual(siblingOrder,['personal','client']);assert.equal(labels.find(x=>x.id==='personal').parentId,'projects','reordering siblings cannot reparent a label');
  await sidebar.getByRole('button',{name:de['labels.collapse'].replace('{name}','Kunde'),exact:true}).click();await link('invoices').waitFor({state:'detached'});
  await row('client').getByRole('button',{name:de['labels.actions'].replace('{name}','Kunde'),exact:true}).click();await page.getByRole('menuitem',{name:de['labels.createChild'],exact:true}).click();
  let dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('combobox',{name:de['labels.parent'],exact:true}).inputValue(),'client');await dialog.getByRole('textbox',{name:de['navigation.folderName'],exact:true}).fill('Angebote');await dialog.getByRole('button',{name:de['navigation.createFolder'],exact:true}).click();await dialog.waitFor({state:'hidden'});await link('created').waitFor();assert.equal(writes.at(-1).parentId,'client');await link('created').scrollIntoViewIfNeeded();assert(await link('created').evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}),'the last nested label is reachable');
  await page.locator('[data-fixture-toggle]').click();const parent=settings.locator('#label-parent-projects');await parent.waitFor();assert.equal(await parent.locator('option[value="client"]').count(),0,'descendants cannot be selected as parents');assert.equal(await parent.locator('option[value="projects"]').count(),0);
  const clientParent=settings.locator('#label-parent-client');failMove=true;await clientParent.selectOption('notes');await settings.getByRole('alert').waitFor();assert.equal(labels.find(x=>x.id==='client').parentId,'projects');assert.equal(await clientParent.inputValue(),'projects');
  failMove=false;await clientParent.selectOption('notes');await page.waitForFunction(()=>document.querySelector('#label-parent-client')?.value==='notes');assert.equal(writes.at(-1).parentId,'notes');
  const hideNotes=settings.getByRole('switch',{name:de['labels.visibility.toggle'].replace('{name}','Notizen'),exact:true});await hideNotes.click();await page.waitForFunction(()=>!document.querySelector('[data-sidebar] a[href="/folders/notes"]'));assert.equal(await link('client').count(),1,'hiding a parent does not hide a visible child');assert.equal(await link('client').innerText(),'Notizen / Kunde');
  await hideNotes.click();await page.waitForFunction(()=>document.querySelector('[data-sidebar] a[href="/folders/notes"]'));await page.locator('[data-fixture-toggle]').click();await link('invoices').scrollIntoViewIfNeeded();
  if(viewport.width===390)await page.screenshot({path:'/tmp/mailflare-nested-labels-mobile.png'});
  await row('notes').getByRole('button',{name:de['labels.actions'].replace('{name}','Notizen'),exact:true}).click();await page.getByRole('menuitem',{name:de['labels.delete'],exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:de['labels.delete'],exact:true}).click();await dialog.waitFor({state:'hidden'});await link('notes').waitFor({state:'detached'});await link('invoices').waitFor();assert.equal(await link('client').innerText(),'Kunde');
  await page.evaluate(()=>{window.__readOnly=true;window.dispatchEvent(new Event('fixture:mailbox'));});await page.locator('[data-fixture-toggle]').click();assert.equal(await settings.getByRole('combobox').count(),0,'read-only delegates can change visibility but not hierarchy');assert((await settings.getByRole('switch').count())>0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({viewport,parentDragPreservesSubtree:true,treeExpandCollapsePersistence:true,siblingReorder:true,createChild:true,reparentAndRetry:true,cyclesExcluded:true,hiddenParentKeepsChild:true,deleteParentKeepsChild:true,noOverflow:true}));await page.close();

 }
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
