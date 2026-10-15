// Actual production router/assets, cold first visits and synthetic private APIs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-category-tabs-'));
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const origin=`http://127.0.0.1:${port}`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const categories=['inbox','invoices','promotions','social','orders'];
let preview,browser,serverLog='';
const user={id:'owner',email:'owner@example.test',name:'Test User',role:'admin',isPrimaryAdmin:true,hasAvatar:false};
const mail=(folder,index=0)=>({id:folder+'-'+index,mailboxId:'box',direction:'inbound',status:'received',category:folder==='inbox'?'primary':folder,read:true,starred:false,fromAddr:'sender@example.test',toAddr:'owner@example.test',subject:folder+' mail '+index,snippet:'Preview for '+folder,createdAt:'2026-10-15T10:00:00Z',labels:[]});
function response(url){
 const path=url.pathname;
 if(path==='/api/auth/me')return {user,hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages'){const category=url.searchParams.get('category')||'primary',folder=category==='primary'?'inbox':category,offset=Number(url.searchParams.get('offset')||0);return {messages:Array.from({length:25},(_,i)=>mail(folder,offset+i)),total:60,limit:25,offset};}
 if(path==='/api/messages/navigation')return {messages:Array.from({length:25},(_,i)=>({id:'invoices-'+i,read:true}))};
 if(/^\/api\/messages\/[^/]+$/.test(path)&&!['counts','bulk-jobs'].includes(path.split('/').at(-1))){const id=path.split('/').at(-1),[folder,index]=id.split('-');return {message:mail(folder,Number(index)),body:{textBody:'Content for '+id,htmlBody:null},attachments:[]};}
 if(path==='/api/messages/counts')return {counts:{folders:Object.fromEntries([...categories,'starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'].map(folder=>[folder,{total:60,unread:0}])),customFolders:{},mailboxes:[]}};
 if(path==='/api/agent/availability')return {enabled:false};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 return {folders:[],jobs:[],job:null,messages:[],hiddenLabelIds:[],ok:true};
}
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const [width,layout] of [[1440,'bottom'],[1440,'right'],[1440,'off'],[390,'bottom'],[390,'off']]){
  const page=await browser.newPage({viewport:{width,height:900}}),events=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('request',request=>events.push({path:new URL(request.url()).pathname,query:new URL(request.url()).search,type:request.resourceType()}));
  await page.addInitScript(layout=>localStorage.setItem('mailflare-reading-layout',layout),layout);
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url());await pause(url.pathname==='/api/messages'?350:50);await route.fulfill({contentType:'application/json',body:JSON.stringify(response(url))}).catch(()=>{});});
  // Keep each cold RSC route in flight long enough to observe the shell.
  await page.route(/\/(?:invoices|promotions|social|orders)(?:\?.*)?$/,async route=>{if(route.request().headers().rsc==='1')await pause(500);await route.continue();});
  await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});try{await page.locator('[data-message-row="inbox-0"]').waitFor();}catch(error){await page.screenshot({path:'/tmp/mailflare-category-tabs-failure.png'});console.error(JSON.stringify({url:page.url(),errors,events,text:await page.locator('body').innerText()}));throw error;}
  const unreadResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/messages'&&url.searchParams.get('read')==='unread';});
  await page.getByRole('button',{name:'Show unread emails only',exact:true}).click();await unreadResponse;
  await page.getByRole('button',{name:'Next page',exact:true}).click();await page.locator('[data-message-row="inbox-25"]').waitFor();
  await page.evaluate(()=>{window.__categoryNodes={tabs:document.querySelector('[data-inbox-categories]'),pane:document.querySelector('[data-message-reading-pane]'),header:document.querySelector('header'),main:document.querySelector('main')};window.__categoryDetached=[];window.__categoryObserver=new MutationObserver(()=>{for(const [name,node]of Object.entries(window.__categoryNodes))if(node&&!node.isConnected&&!window.__categoryDetached.includes(name))window.__categoryDetached.push(name);});window.__categoryObserver.observe(document.body,{childList:true,subtree:true});});
  const check=async folder=>{assert.deepEqual(await page.evaluate(()=>window.__categoryDetached),[],`cold ${folder} must not remove the category bar, reader or shell`);assert(await page.evaluate(()=>window.__categoryNodes.tabs===document.querySelector('[data-inbox-categories]')),'category bar stays mounted');};
  for(const folder of ['invoices','promotions','social','orders','inbox']){
   await page.locator(`[data-inbox-categories] a[href="/${folder}"]`).click();await pause(100);await check(folder);
   await page.waitForURL('**/'+folder);await page.locator(`[data-message-row="${folder}-0"]`).waitFor();await check(folder);
   assert.equal(await page.locator('[data-inbox-categories] [aria-current="page"]').getAttribute('href'),'/'+folder);
   assert.equal(await page.locator('[data-message-row]').count(),25);
  }
  await page.goBack();await page.locator('[data-message-row="orders-0"]').waitFor();await check('back');
  await page.goForward();await page.locator('[data-message-row="inbox-0"]').waitFor();await check('forward');
  for(const folder of ['invoices','promotions','social','orders'])for(const event of events.filter(event=>event.path==='/api/messages'&&new URLSearchParams(event.query).get('category')===folder)){
   const params=new URLSearchParams(event.query);assert(!params.has('offset'),'category starts on its first page');assert(!params.has('read'),'category never inherits the inbox unread filter');
  }
  await page.locator('[data-inbox-categories] a[href="/invoices"]').click();await page.locator('[data-message-row="invoices-0"]').waitFor();await page.locator('[data-message-row="invoices-0"] a').first().click();try{await page.getByText('Content for invoices-0',{exact:true}).waitFor();}catch(error){await page.screenshot({path:'/tmp/mailflare-category-reader-failure.png'});console.error(JSON.stringify({width,layout,url:page.url(),errors,requests:events.filter(event=>event.path.startsWith('/api/messages')),text:await page.locator('body').innerText()}));throw error;}assert.equal(new URL(page.url()).pathname,'/invoices/invoices-0');
  await page.goBack();await page.locator('[data-message-row="invoices-0"]').waitFor();assert.equal(new URL(page.url()).pathname,'/invoices');
  assert.equal(events.filter(event=>event.type==='document').length,1,'category navigation never requests another document');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,layout,coldCategoryShellPreserved:true,history:true,singleDocument:true,scopeReset:true,categoryReader:true}));await page.close();
 }
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-category-tabs-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
