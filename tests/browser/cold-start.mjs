// Actual production assets and router. Private APIs use synthetic data; no live mailbox is read.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-cold-browser-'));
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
let origin=process.env.MAILFLARE_COLD_START_ORIGIN,preview,browser,serverLog='';
const user={id:'cold-user',email:'owner@example.test',name:'Test User',role:'admin',isPrimaryAdmin:true,canManageMailboxes:true,canManageDomains:true,canManageUsers:true,hasAvatar:false};
const messages=Array.from({length:25},(_,i)=>({id:'cold-'+i,mailboxId:'cold-box',direction:'inbound',status:'received',category:'primary',read:true,starred:false,fromAddr:i===0?'Apple <receipt@apple.com>':'sender'+i+'@example.test',fromContactHasAvatar:false,toAddr:'owner@example.test',subject:'Cold start mail '+i,snippet:'Preview '+i,labels:[],createdAt:'2026-10-15T06:00:00Z'}));
const counts={folders:Object.fromEntries(['inbox','promotions','social','invoices','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'].map(key=>[key,{total:25,unread:0}])),customFolders:{},mailboxes:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),results=[];
function response(path){
 if(path==='/api/auth/me')return {user,hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'cold-box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages/bulk-jobs')return {job:{id:'previous-job',requestId:'previous-request',scope:{folder:'all',mailboxId:'cold-box',query:'',unreadOnly:false,title:'All mail'},action:'read',status:'done',processed:60000,total:60000}};
 if(path==='/api/messages')return {messages,total:25,offset:0,limit:25};
 if(/^\/api\/messages\/cold-\d+\/star$/.test(path))return {starred:true};
 if(/^\/api\/messages\/cold-\d+$/.test(path)){const id=path.split('/').at(-1);return {message:messages.find(message=>message.id===id),body:{textBody:'Message content '+id,htmlBody:null},attachments:[]};}
 if(path==='/api/agent/availability')return {enabled:true};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 if(path==='/api/agent/settings')return {settings:{mailboxId:'cold-box',enabled:true,dailyLimit:100,instructions:''},models:[],canManage:true,providerConfigured:true,reviewers:[]};
 return {folders:[],jobs:[],accounts:[],messages:[],counts,hiddenLabelIds:[],ok:true};
}
async function screen(width,{failDetail=false,holdRoute=false,slowCounts=false}={}){
 const page=await browser.newPage({viewport:{width,height:900}}),events=[],errors=[];const state={failDetail,release:null,held:false};
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>events.push({at:Date.now(),path:new URL(request.url()).pathname,type:request.resourceType(),prefetch:request.headers()['next-router-prefetch'],rsc:request.headers().rsc,background:request.headers()['x-mailflare-preload']==='1'}));
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;if(state.failDetail&&path==='/api/messages/cold-0')return route.abort('failed');await pause(slowCounts&&path==='/api/messages/counts'?6000:100);await route.fulfill({contentType:'application/json',body:JSON.stringify(response(path))}).catch(()=>{});});
 if(holdRoute)await page.route('**/inbox/cold-0*',async route=>{
  if(route.request().headers().rsc!=='1')return route.continue();state.held=true;const reply=await route.fetch();await new Promise(resolve=>state.release=resolve);await route.fulfill({response:reply}).catch(()=>{});
 });
 const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:1500000,uploadThroughput:750000});
 const start=Date.now();await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded',timeout:60000});const first=page.getByText('Cold start mail 0',{exact:true}).first();await first.waitFor({timeout:30000});const listAt=Date.now();
 return {page,events,errors,state,start,listAt,first};
}
try{
 if(!origin){origin=`http://127.0.0.1:${port}`;preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Local preview exited');await pause(200);}assert(ready,'production preview starts');
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 if(!process.env.MAILFLARE_ROW_ONLY){
 for(const width of [1440,390]){
  const {page,events,errors,state,start,listAt,first}=await screen(width,{holdRoute:true});
  await pause(300);
  assert.equal(events.filter(event=>event.path==='/api/auth/me').length,1,'shell identity consumers reuse the guard validation');
  assert.equal(events.filter(event=>event.path==='/api/messages'&&!event.background).length,1,'previous completed bulk job must not invalidate the initial list');
  assert.equal(events.filter(event=>event.path==='/api/messages/counts').length,1,'startup counters are queried once');
  const beforeClick=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.endsWith('.js')).map(entry=>({name:new URL(entry.name).pathname,bytes:entry.transferSize})));
  assert(beforeClick.reduce((sum,entry)=>sum+entry.bytes,0)<1_350_000,'startup JavaScript budget stays below 1.35 MB without compression');
  assert(!beforeClick.some(entry=>/\/(?:compose-form|agent-panel)-/.test(entry.name)),'closed editor and assistant are not downloaded at startup');
  assert(!beforeClick.some(entry=>/\/(?:command-palette|shortcuts-help-dialog)-/.test(entry.name)),'closed shortcut dialogs stay out of the startup path');
  assert.equal(events.filter(event=>event.rsc&&event.prefetch&&event.at<listAt).length,0,'folder route prefetch must wait until the visible list is ready');
  if(width===1440){
   await page.locator('button[title="Open Command Palette (⌘K)"]').click();const command=page.getByPlaceholder('Type a command or search actions...');await command.waitFor();assert(await command.evaluate(input=>input===document.activeElement),'deferred palette receives keyboard focus');await page.keyboard.press('Escape');await command.waitFor({state:'hidden'});
   await page.getByRole('button',{name:/Shortcuts.*\?/i}).click();await page.getByRole('heading',{name:'Keyboard Shortcuts',exact:true}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).last().click();
  }
  await first.click();const clicked=Date.now();await page.locator('[data-message-opening]').waitFor();const acknowledgementMs=Date.now()-clicked;assert(acknowledgementMs<1000,'first click must receive immediate feedback');assert.equal(await page.locator('[data-message-opening] h1').textContent(),'Cold start mail 0');
  await page.waitForFunction(()=>true);for(let i=0;i<100&&!state.release;i++)await pause(20);assert(state.held&&state.release,'real router navigation is pending');
  assert(events.some(event=>event.path==='/api/messages/cold-0'),'body starts before the route response returns');assert.equal(await page.getByText('Message content cold-0',{exact:true}).count(),0);
  state.release();await page.getByText('Message content cold-0',{exact:true}).waitFor({timeout:15000});assert.equal(await page.locator('[data-message-opening]').count(),0);assert.equal(new URL(page.url()).pathname,'/inbox/cold-0');
  assert.deepEqual(errors,[]);const metrics={width,listMs:listAt-start,readerAfterClickMs:Date.now()-clicked,requestCount:events.length,acknowledgementMs,initialJsBytes:beforeClick.reduce((total,entry)=>total+entry.bytes,0),firstClickAcknowledged:true,parallelDetail:true,noEagerRoutePrefetch:true};results.push(metrics);console.log(JSON.stringify(metrics));if(width===1440){await page.getByRole('button',{name:'AI summary',exact:true}).click();const prompt=page.getByPlaceholder('Enter a prompt here');await prompt.waitFor();await page.waitForFunction(()=>document.querySelector('textarea[name=message]')?.value.includes('cold-0'));assert((await prompt.inputValue()).includes('cold-0'),'the first request survives deferred assistant loading');console.log(JSON.stringify({firstDeferredAssistantRequestPreserved:true}));}await page.close();
 }
 // Slow optional counts never gate the menu, list or first message interaction.
 {
  const {page,first,errors,start,listAt}=await screen(1440,{slowCounts:true});
  await page.locator('a[href="/inbox"]').first().waitFor({state:'visible'});
  await first.click();await page.getByText('Message content cold-0',{exact:true}).waitFor({timeout:10000});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({slowCounterDoesNotBlockFirstClick:true,listMs:listAt-start}));await page.close();
 }
 // An early second click must win over an older route response.
 {
  const {page,state,first}=await screen(1440,{holdRoute:true});await first.click();for(let i=0;i<100&&!state.release;i++)await pause(20);assert(state.release);await page.getByText('Cold start mail 1',{exact:true}).first().click();await page.getByText('Message content cold-1',{exact:true}).waitFor();state.release();await pause(500);assert.equal(new URL(page.url()).pathname,'/inbox/cold-1');assert.equal(await page.getByText('Message content cold-0',{exact:true}).count(),0);console.log(JSON.stringify({rapidClicksLatestWins:true}));await page.close();
 }
 // Back remains usable even while the first route response is still pending.
 {
  const {page,state,first}=await screen(390,{holdRoute:true});await first.click();await page.locator('[data-message-opening]').waitFor();for(let i=0;i<100&&!state.release;i++)await pause(20);assert(state.release);await page.clock.install();await page.clock.fastForward(16000);await page.locator('[data-message-retry]').waitFor();await page.locator('[data-message-back]').click();assert.equal(await page.locator('[data-message-opening]').count(),0);assert.equal(await page.locator('[data-message-navigation-progress]').count(),0,'cancelling must clear the navigation indicator');state.release();await pause(500);assert.equal(new URL(page.url()).pathname,'/inbox');await page.getByText('Cold start mail 0',{exact:true}).first().waitFor();console.log(JSON.stringify({earlyBackCancels:true}));await page.close();
 }
 // First-load transport failure must offer a retry rather than leave a dead reader.
 {
  const {page,state,first,errors}=await screen(1440,{failDetail:true});await first.click();const retry=page.getByRole('button',{name:'Try again',exact:true});await retry.waitFor({timeout:20000});assert(await page.getByRole('alert').filter({hasText:'This email could not be loaded'}).isVisible());state.failDetail=false;await retry.click();await page.getByText('Message content cold-0',{exact:true}).waitFor();assert.deepEqual(errors,[]);console.log(JSON.stringify({failedFirstLoadRecoverable:true}));await page.getByRole('button',{name:'Compose',exact:true}).first().click();const close=page.getByRole('button',{name:'Close composer',exact:true});await close.waitFor();await close.click();await page.getByText('Message content cold-0',{exact:true}).waitFor();assert.deepEqual(errors,[]);console.log(JSON.stringify({firstDeferredComposerOpensAndCloses:true}));await page.close();
 }
 // Clicking an already-selected failed mail must retry; same-URL router pushes alone do nothing.
 {
  const {page,state,first}=await screen(1440,{failDetail:true});await first.click();await page.getByRole('button',{name:'Try again',exact:true}).waitFor();state.failDetail=false;await page.getByText('Cold start mail 0',{exact:true}).first().click();await page.getByText('Message content cold-0',{exact:true}).waitFor();assert.equal(await page.locator('[data-message-opening]').count(),0);console.log(JSON.stringify({sameSelectedRowCanRetry:true}));await page.close();
 }
 }
 // Native links must cover row padding/gaps, while selection and quick actions stay independent.
 for(const width of [1440,390]){
  const {page,errors,events}=await screen(width);
  const row=id=>page.locator(`[data-message-row="cold-${id}"]`);
  for(const [id,position] of [[0,'left'],[1,'top'],[2,'bottom'],[3,'right']]){
   await row(id).scrollIntoViewIfNeeded();const box=await row(id).boundingBox();assert(box);
   const point={x:position==='left'?box.x+4:position==='right'?box.x+box.width-4:box.x+box.width/2,y:position==='top'||position==='right'?box.y+2:position==='bottom'?box.y+box.height-2:box.y+box.height/2};
   assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('a')?.getAttribute('href'),point),`/inbox/cold-${id}`,`${position} whitespace belongs to the native mail link`);
   await page.mouse.click(point.x,point.y);await page.getByText(`Message content cold-${id}`,{exact:true}).waitFor();
   assert.equal(new URL(page.url()).pathname,`/inbox/cold-${id}`);
   if(id===0){
    const logo=page.locator('[data-message-content] img[src="/sender-logos/apple.svg"]');await logo.waitFor();
    assert.equal(await logo.getAttribute('loading'),'eager');assert.equal(await logo.getAttribute('fetchpriority'),'high');
    assert(!events.some(event=>event.path==='/api/contacts/avatar'),'reading a sender without a saved photo must never probe a missing contact photo');
   }
   if(width<768){await page.locator('[data-message-back]').click();await row(id).waitFor();}
  }
  await page.evaluate(()=>{window.__rowLinkClicks=0;document.addEventListener('click',event=>{if(event.target.closest('[data-message-row] a'))window.__rowLinkClicks++;});});
  const checkbox=row(4).locator('input[type=checkbox]'),selection=width<768?row(4).locator('label'):checkbox;await selection.click();assert(await checkbox.isChecked());
  // Desktop checkbox selection intentionally previews the selected mail; preserve that existing behavior.
  if(width>=768)await page.getByText('Message content cold-4',{exact:true}).waitFor();
  await selection.click();assert(!(await checkbox.isChecked()));assert.equal(await page.evaluate(()=>window.__rowLinkClicks),0,'selection does not activate the stretched link');const before=page.url();
  const star=row(5).getByRole('button',{name:'Not starred',exact:true});await star.click();await row(5).getByRole('button',{name:'Starred',exact:true}).waitFor();assert.equal(page.url(),before,'star does not open the email');
  if(width>=768){await row(6).hover();await row(6).getByRole('button',{name:'Archive',exact:true}).click();await row(6).waitFor({state:'detached'});assert.equal(page.url(),before,'archive does not open the email');}
  const link=row(7).locator('a[href="/inbox/cold-7"]');await link.focus();await page.keyboard.press('Enter');await page.getByText('Message content cold-7',{exact:true}).waitFor();assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,wholeRowClickable:true,independentControls:true,nativeKeyboardNavigation:true}));await page.close();
 }
 if(results.length)writeFileSync('/tmp/mailflare-cold-after.json',JSON.stringify(results,null,2));
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-cold-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
