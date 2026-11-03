// Actual production router/assets, cold first visits and synthetic private APIs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-category-tabs-'));
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const origin=`http://127.0.0.1:${port}`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const categories=['inbox','invoices','promotions','social','orders'];
const baseline=process.env.MAILFLARE_CATEGORY_BASELINE==='1';
const touch=process.env.MAILFLARE_CATEGORY_TOUCH==='1';
const locale=touch?'de':'en',translations=JSON.parse(readFileSync(touch?'public/locales/de.json':'src/lib/i18n/en.json','utf8'));
const rscDelay=Number(process.env.MAILFLARE_CATEGORY_RSC_MS??500),listDelay=Number(process.env.MAILFLARE_CATEGORY_API_MS??350);
const cases=process.env.MAILFLARE_CATEGORY_CASES?.split(',').map(value=>{const [width,layout]=value.split(':');return [Number(width),layout];})??[[1440,'bottom'],[1440,'right'],[1440,'off'],[744,'bottom'],[390,'bottom'],[390,'off']];
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
async function backTarget(page){
 // The reader may commit between a CDP history snapshot and a later Back.
 // Observe the browser's chosen target synchronously, before router handlers.
 const target=await page.evaluate(()=>new Promise((resolve,reject)=>{
  const onPop=()=>{clearTimeout(timer);resolve(location.pathname);};
  const timer=setTimeout(()=>{window.removeEventListener('popstate',onPop,true);reject(Error('Back did not emit popstate'));},5000);
  window.addEventListener('popstate',onPop,{capture:true,once:true});
  window.history.back();
 }));
 assert(['/orders','/invoices'].includes(target),`Back returns to the preceding overview: ${target}`);
 return target;
}
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const [width,layout] of cases){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:touch}),events=[],errors=[];
  await page.context().addCookies([{name:'mailflare-locale',value:locale,url:origin}]);
  const selectCategory=async folder=>{const tab=page.locator(`[data-category-tab="${folder}"]`);if(touch)await tab.tap();else await tab.click();};
  const listDelays={};
  await page.routeWebSocket('**/api/realtime',()=>{});
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('request',request=>events.push({path:new URL(request.url()).pathname,query:new URL(request.url()).search,type:request.resourceType(),rsc:request.headers().rsc==='1'}));
  await page.addInitScript(({layout,touch})=>{
   localStorage.setItem('mailflare-reading-layout',layout);
   // Disable speculative folder warming so first visits measure genuinely cold data.
   Object.defineProperty(navigator,'connection',{value:Object.assign(new EventTarget(),{saveData:true})});
   window.__categoryTimings=[];
   let touchStart=null;
   document.addEventListener('pointerdown',event=>{const tab=event.target.closest('[data-category-tab]');if(tab&&event.pointerType==='touch')touchStart={folder:tab.dataset.categoryTab,time:performance.now()};},true);
   document.addEventListener('click',event=>{
    const tab=event.target.closest('[data-category-tab]');if(!tab)return;
    const folder=tab.dataset.categoryTab,start=touch&&touchStart?.folder===folder?touchStart.time:performance.now(),sample={folder,activeMs:null,rowsMs:null,staleRows:false};window.__categoryTimings.push(sample);
    const inspect=()=>{
     if(document.querySelector('[data-inbox-categories] [aria-current="page"]')?.getAttribute('href')!==`/${folder}`)return;
     const rows=[...document.querySelectorAll('[data-message-row]')];
     if(sample.activeMs===null){sample.activeMs=performance.now()-start;sample.staleRows=rows.some(row=>!row.dataset.messageRow.startsWith(folder+'-'));}
     if(rows.some(row=>row.dataset.messageRow===folder+'-0')){sample.rowsMs=performance.now()-start;observer.disconnect();}
    };
    const observer=new MutationObserver(inspect);observer.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-current']});queueMicrotask(inspect);
   },true);
  },{layout,touch});
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url());await pause(url.pathname==='/api/messages'?(listDelays[url.searchParams.get('category')]??listDelay):50);await route.fulfill({contentType:'application/json',body:JSON.stringify(response(url))}).catch(()=>{});});
  // Keep each cold RSC route in flight long enough to observe the shell.
  await page.route(/\/(?:invoices|promotions|social|orders)(?:\?.*)?$/,async route=>{if(route.request().headers().rsc==='1')await pause(rscDelay);await route.continue().catch(()=>{});});
  await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});try{await page.locator('[data-message-row="inbox-0"]').waitFor();}catch(error){await page.screenshot({path:'/tmp/mailflare-category-tabs-failure.png'});console.error(JSON.stringify({url:page.url(),errors,events,text:await page.locator('body').innerText()}));throw error;}
  const unreadResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/messages'&&url.searchParams.get('read')==='unread';});
  await page.getByRole('button',{name:translations['list.showUnreadOnly'],exact:true}).click();await unreadResponse;
  await page.getByRole('button',{name:translations['list.nextPage'],exact:true}).click();await page.locator('[data-message-row="inbox-25"]').waitFor();
  await page.evaluate(()=>{window.__categoryNodes={tabs:document.querySelector('[data-inbox-categories]'),pane:document.querySelector('[data-message-reading-pane]'),header:document.querySelector('header'),main:document.querySelector('main')};window.__categoryDetached=[];window.__categoryObserver=new MutationObserver(()=>{for(const [name,node]of Object.entries(window.__categoryNodes))if(node&&!node.isConnected&&!window.__categoryDetached.includes(name))window.__categoryDetached.push(name);});window.__categoryObserver.observe(document.body,{childList:true,subtree:true});});
  const check=async folder=>{assert.deepEqual(await page.evaluate(()=>window.__categoryDetached),[],`cold ${folder} must not remove the category bar, reader or shell`);assert(await page.evaluate(()=>window.__categoryNodes.tabs===document.querySelector('[data-inbox-categories]')),'category bar stays mounted');};
  for(const folder of ['invoices','promotions','social','orders','inbox']){
   await selectCategory(folder);await pause(100);await check(folder);
   await page.waitForURL('**/'+folder);await page.locator(`[data-message-row="${folder}-0"]`).waitFor();await check(folder);
   assert.equal(await page.locator('[data-inbox-categories] [aria-current="page"]').getAttribute('href'),'/'+folder);
   assert.equal(await page.locator('[data-message-row]').count(),25);
  }
  const coldRsc=events.filter(event=>event.rsc&&categories.some(folder=>event.path==='/'+folder)).length;
  if(!baseline)assert.equal(coldRsc,0,'client-owned category overviews require no RSC navigation');
  await page.goBack();await page.locator('[data-message-row="orders-0"]').waitFor();await check('back');
  await page.goForward();await page.locator('[data-message-row="inbox-0"]').waitFor();await check('forward');
  for(const folder of ['invoices','promotions','social','orders'])for(const event of events.filter(event=>event.path==='/api/messages'&&new URLSearchParams(event.query).get('category')===folder)){
   const params=new URLSearchParams(event.query);assert(!params.has('offset'),'category starts on its first page');assert(!params.has('read'),'category never inherits the inbox unread filter');
  }
  await selectCategory('invoices');await page.locator('[data-message-row="invoices-0"]').waitFor();await page.locator('[data-message-row="invoices-0"] a').first().click();try{await page.getByText('Content for invoices-0',{exact:true}).waitFor();}catch(error){await page.screenshot({path:'/tmp/mailflare-category-reader-failure.png'});console.error(JSON.stringify({width,layout,url:page.url(),errors,requests:events.filter(event=>event.path.startsWith('/api/messages')),text:await page.locator('body').innerText()}));throw error;}assert.equal(new URL(page.url()).pathname,'/invoices/invoices-0');
  await page.goBack();await page.locator('[data-message-row="invoices-0"]').waitFor();assert.equal(new URL(page.url()).pathname,'/invoices');
  await page.goForward();await page.getByText('Content for invoices-0',{exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/invoices/invoices-0');
  await page.goBack();await page.locator('[data-message-row="invoices-0"]').waitFor();
  const recoveryStart=events.length;
  await selectCategory('promotions');await page.locator('[data-message-row="promotions-0"]').waitFor();
  const historyRecoveryRsc=events.slice(recoveryStart).filter(event=>event.rsc).length;
  if(!baseline)assert.equal(historyRecoveryRsc,1,'the first category after traversal supersedes any outstanding router request');
  const warmStart=events.length;
  for(const folder of ['social','orders','inbox']){await selectCategory(folder);await page.locator(`[data-message-row="${folder}-0"]`).waitFor();}
  const warmRequests=events.slice(warmStart).filter(event=>event.rsc||event.path==='/api/messages').length;
  if(!baseline)assert.equal(warmRequests,0,'warm categories use the existing scoped list cache without another route request');
  let touchStrip='not tested';
  if(touch){
   const strip=page.locator('.mail-category-strip');
   const overflow=await strip.evaluate(element=>element.scrollWidth>element.clientWidth+1);
   if(overflow){
    await strip.evaluate(element=>{element.scrollLeft=0;});
    const box=await strip.boundingBox(),cdp=await page.context().newCDPSession(page),y=box.y+box.height/2;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width*.8,y}]});
    for(let step=1;step<=8;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width*(.8-step*.075),y}]});await pause(20);}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100);await cdp.detach();
    assert(await strip.evaluate(element=>element.scrollLeft>0),'the category strip responds to a horizontal touch swipe');
    assert.equal(await page.locator('[data-inbox-categories] [aria-current="page"]').getAttribute('href'),'/inbox','a swipe never selects another category');
    touchStrip='horizontal swipe passed';
   }else touchStrip='all tabs fit';
  }
  assert.equal(events.filter(event=>event.type==='document').length,1,'category navigation never requests another document');assert.deepEqual(errors,[]);
  const timings=await page.evaluate(()=>window.__categoryTimings);
  assert(timings.every(sample=>!sample.staleRows),'an active category never presents messages from another category');
  if(!baseline)assert(timings.slice(0,5).every(sample=>sample.activeMs<200),'category feedback must not wait for the deliberately delayed RSC or message API');
  console.log(JSON.stringify({width,layout,locale,input:touch?'touch-pointerdown':'click',touchStrip,rscDelay,listDelay,coldCategoryShellPreserved:true,history:true,singleDocument:true,scopeReset:true,categoryReader:true,coldRsc,historyRecoveryRsc,warmRequests,timings}));
  if(!baseline){
   // Three cold lists finish in reverse order; only the latest choice may appear.
   listDelays.invoices=700;listDelays.promotions=450;listDelays.social=150;
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('mailflare:messages-changed')));
   for(const folder of ['invoices','promotions','social']){await selectCategory(folder);await pause(25);}
   await page.locator('[data-message-row="social-0"]').waitFor();await pause(750);
   assert.equal(new URL(page.url()).pathname,'/social');assert(await page.locator('[data-message-row]').evaluateAll(rows=>rows.every(row=>row.dataset.messageRow.startsWith('social-'))));
   if(width===1440&&layout==='bottom'){
    await page.route(/\/(?:invoices\/invoices-[234]|all|settings\/account)(?:\?.*)?$/,async route=>{if(route.request().headers().rsc==='1')await pause(1100);await route.continue().catch(()=>{});});
    // A pending real reader must be superseded even when the current tab is tapped.
    await selectCategory('invoices');await page.locator('[data-message-row="invoices-2"]').waitFor();
    const readerRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/invoices/invoices-2'&&request.headers().rsc==='1');
    await page.locator('[data-message-row="invoices-2"] a').first().click();await readerRequest;
    await selectCategory('invoices');await pause(75);
    assert.equal(await page.locator('[data-message-opening]').count(),0,'tapping the current category cancels the pending reader preview');
    await selectCategory('orders');await page.locator('[data-message-row="orders-0"]').waitFor();await pause(1200);
    assert.equal(new URL(page.url()).pathname,'/orders');assert.equal(await page.getByText('Content for invoices-2',{exact:true}).count(),0);
    // Sidebar and plain Settings links use the same transition-start guard.
    for(const target of ['/all','/settings/account']){
     const pendingRequest=page.waitForRequest(request=>new URL(request.url()).pathname===target&&request.headers().rsc==='1');
     await page.locator(`a[href="${target}"]:visible`).first().click();await pendingRequest;
     await selectCategory('promotions');await page.locator('[data-message-row="promotions-0"]').waitFor();await pause(1200);
     assert.equal(new URL(page.url()).pathname,'/promotions');
     const requestsBefore=events.filter(event=>event.rsc).length;
     await selectCategory('orders');await page.locator('[data-message-row="orders-0"]').waitFor();
     assert.equal(events.filter(event=>event.rsc).length,requestsBefore,'completed fallback releases the pending guard');
    }
    await selectCategory('invoices');await page.locator('[data-message-row="invoices-3"]').waitFor();
    const interruptedReader=page.waitForRequest(request=>new URL(request.url()).pathname==='/invoices/invoices-3'&&request.headers().rsc==='1');
    await page.locator('[data-message-row="invoices-3"] a').first().click();await interruptedReader;
    // Vinext may already have committed a cached reader shell while its RSC is
    // pending. Back must restore the actual preceding entry in either case.
    const returnedPath=await backTarget(page);
    console.log(JSON.stringify({backTarget:returnedPath}));
    await page.waitForURL(url=>url.pathname===returnedPath);await page.locator(`[data-message-row="${returnedPath.slice(1)}-0"]`).waitFor();await pause(1200);
    assert.equal(new URL(page.url()).pathname,returnedPath,'Back cannot be overwritten after the pending reader response arrives');
    await selectCategory('orders');await page.locator('[data-message-row="orders-0"]').waitFor();
    const raceSession=await page.context().newCDPSession(page);
    await raceSession.send('Emulation.setCPUThrottlingRate',{rate:6});
    console.log(JSON.stringify({phase:'pending-reader-back-rapid-categories',cpuSlowdown:6}));
    await selectCategory('invoices');await page.locator('[data-message-row="invoices-4"]').waitFor();
    const secondInterruptedReader=page.waitForRequest(request=>new URL(request.url()).pathname==='/invoices/invoices-4'&&request.headers().rsc==='1');
    await page.locator('[data-message-row="invoices-4"] a').first().click();await secondInterruptedReader;
    const secondBackTarget=await backTarget(page);
    console.log(JSON.stringify({backTarget:secondBackTarget}));
    await page.waitForURL(url=>url.pathname===secondBackTarget);
    await selectCategory('social');await pause(75);await selectCategory('promotions');
    await page.locator('[data-message-row="promotions-0"]').waitFor();await pause(1200);
    assert.equal(new URL(page.url()).pathname,'/promotions','the latest category after Back cannot be overwritten by the earlier reader or category');
    await raceSession.send('Emulation.setCPUThrottlingRate',{rate:1});await raceSession.detach();
   }
   await page.reload();await page.locator('[data-message-row="'+new URL(page.url()).pathname.slice(1)+'-0"]').waitFor();
   await page.goto(origin+'/social',{waitUntil:'domcontentloaded'});await page.locator('[data-message-row="social-0"]').waitFor();
   assert.deepEqual(errors,[]);console.log(JSON.stringify({width,layout,outOfOrderLists:true,deepLinkAndReload:true,pendingReaderAndSidebar:width===1440&&layout==='bottom'}));
  }
  await page.close();
 }
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-category-tabs-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
