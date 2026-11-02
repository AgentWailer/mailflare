// Production assets and synthetic mail only. Run after npm run build; run preview suites sequentially.
// Chromium safe-area/layout regression: this does not emulate native iPadOS chrome or its keyboard.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-viewport-'));
const output=process.env.STANDALONE_OUTPUT||'/tmp/mailflare-standalone-viewport';
mkdirSync(output,{recursive:true});
const reserve=createServer();
await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;
await new Promise(resolve=>reserve.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const messages=Array.from({length:25},(_,i)=>({id:`viewport-${i}`,mailboxId:'box',direction:'inbound',status:'received',category:'primary',read:i%3===0,starred:false,fromAddr:`Beispiel ${i} <sender${i}@example.test>`,toAddr:'owner@example.test',subject:`Nachricht ${i}: Unterlagen und nächste Schritte`,snippet:'Ein ausreichend langer Vorschautext für die unveränderte Nachrichtenliste.',labels:[],createdAt:new Date(Date.UTC(2026,10,2,12,45-i)).toISOString()}));
const folders=['inbox','invoices','promotions','social','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'];
function response(url){
 const path=url.pathname;
 if(path==='/api/auth/me')return {user:{id:'owner',name:'Test User',email:'owner@example.test',role:'user',hasAvatar:false},hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages')return {messages,total:messages.length,limit:25,offset:0};
 if(path==='/api/messages/counts')return {counts:{folders:Object.fromEntries(folders.map(folder=>[folder,{total:25,unread:16}])),customFolders:{},mailboxes:[]}};
 if(path==='/api/folders')return {folders:[]};
 if(path==='/api/agent/availability')return {enabled:false};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 return {folders:[],messages:[],jobs:[],job:null,hiddenLabelIds:[],ok:true};
}

async function metrics(page){
 return page.evaluate(()=>{
  const rect=selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
  const shell=document.querySelector('.mail-mobile-shell');
  const style=getComputedStyle(shell);
  const list=document.querySelector('.mail-mobile-list-scroll');
  return {header:rect('.mail-mobile-header'),profile:rect('[data-app-profile]'),search:rect('[data-mail-search-input]'),shell:rect('.mail-mobile-shell'),list:rect('.mail-mobile-list-scroll'),rootScroll:document.scrollingElement.scrollTop,rootHeight:document.scrollingElement.scrollHeight,viewportHeight:innerHeight,viewportWidth:innerWidth,listScroll:list.scrollTop,listMaxScroll:list.scrollHeight-list.clientHeight,safePadding:{top:parseFloat(style.paddingTop),bottom:parseFloat(style.paddingBottom)},visualViewport:{height:visualViewport.height,offsetTop:visualViewport.offsetTop}};
 });
}
async function assertLayout(page,insets,stage){
 const m=await metrics(page);
 for(const name of ['header','profile','search']){
  const r=m[name];
  assert(r&&r.height>0,`${stage}: ${name} is visible`);
  assert(r.y>=insets.top-1,`${stage}: ${name} overlaps top safe area: ${JSON.stringify(m)}`);
  assert(r.bottom<=m.viewportHeight-insets.bottom+1,`${stage}: ${name} exceeds bottom safe area`);
  assert(r.x>=-1&&r.right<=m.viewportWidth+1,`${stage}: ${name} overflows horizontally`);
 }
 assert.equal(m.rootScroll,0,`${stage}: only the list should scroll`);
 assert(m.rootHeight<=m.viewportHeight+1,`${stage}: document has a scrollable range`);
 assert(m.list.bottom<=m.viewportHeight-insets.bottom+1,`${stage}: scrollable content stays above the bottom safe area`);
 return m;
}
function assertStable(before,after,stage){
 for(const name of ['header','profile','search'])for(const coordinate of ['x','y','width','height'])assert(Math.abs(after[name][coordinate]-before[name][coordinate])<=1,`${stage}: ${name}.${coordinate} shifted`);
}
async function exerciseScroll(page,cdp,insets,touch){
 const before=await assertLayout(page,insets,'before scroll');
 const list=page.locator('.mail-mobile-list-scroll');
 const box=await list.boundingBox();
 assert(before.listMaxScroll>100,'fixture must produce a genuinely scrollable message list');
 const x=box.x+box.width/2;
 const start=Math.min(box.y+box.height-60,box.y+300);
 if(touch){
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start}]});
  for(let i=1;i<=8;i++){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start-i*20}]});
   await pause(16);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }else{
  await page.mouse.move(x,start);
  await page.mouse.wheel(0,300);
 }
 await page.waitForFunction(()=>document.querySelector('.mail-mobile-list-scroll').scrollTop>20);
 await page.waitForTimeout(450);
 const scrolled=await assertLayout(page,insets,'after real input scroll');
 assertStable(before,scrolled,'list scrolling');
 for(const end of ['bottom','top']){
  await list.evaluate((el,end)=>el.scrollTop=end==='bottom'?el.scrollHeight:0,end);
  await page.mouse.move(x,box.y+box.height/2);
  await page.mouse.wheel(0,end==='bottom'?5000:-5000);
  await page.waitForTimeout(180);
  const edge=await assertLayout(page,insets,`${end} edge overscroll`);
  assertStable(before,edge,`${end} edge`);
 }
 // A gesture over the fixed header must not move the document either.
 await page.mouse.move(before.header.x+before.header.width/2,before.header.y+5);
 await page.mouse.wheel(0,1000);
 await page.waitForTimeout(180);
 await page.evaluate(()=>window.scrollTo(0,100));
 const after=await assertLayout(page,insets,'header and document scroll attempt');
 assertStable(before,after,'document scroll attempt');
 return {before,scrolled,after};
}

async function exerciseControls(page,insets){
 const search=page.locator('[data-mail-search-input]');
 await search.focus();
 await page.waitForTimeout(180);
 assert(await search.evaluate(el=>el===document.activeElement),'search retains keyboard focus');
 const searchRect=await search.boundingBox();
 assert(searchRect.y>=insets.top-1,'focused search remains below native status bar');
 // The compact search has an explicit back control; desktop search simply blurs.
 const back=page.locator('[data-search-back]');
 if(await back.isVisible())await back.click();else await search.blur();
 await page.waitForTimeout(180);
 await assertLayout(page,insets,'after search focus');
 const menu=page.getByRole('button',{name:'Menü öffnen',exact:true});
 if(await menu.isVisible()){
  await menu.click();
  const sidebar=page.locator('aside.mail-sidebar');
  await page.waitForFunction(()=>document.querySelector('aside.mail-sidebar')?.getAttribute('aria-hidden')==='false');
  await sidebar.getByRole('button',{name:'Schließen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('aside.mail-sidebar')?.getAttribute('aria-hidden')==='true');
  await assertLayout(page,insets,'after sidebar');
 }
 await page.locator('#mail-quick-settings-toggle').click();
 const settings=page.locator('[data-mail-quick-settings]');
 await settings.waitFor();
 await settings.getByRole('button',{name:'Schließen',exact:true}).click();
 await settings.waitFor({state:'hidden'});
 await page.waitForTimeout(250);
 await assertLayout(page,insets,'after quick settings');
 const compose=page.locator('[data-mobile-compose]');
 if(await compose.isVisible())await compose.click();else await page.getByRole('button',{name:'Verfassen',exact:true}).click();
 const form=page.locator('form.compose-popup');
 await form.waitFor();
 await form.getByRole('button',{name:'Editor schließen',exact:true}).click();
 await form.waitFor({state:'hidden'});
 await page.waitForTimeout(180);
 await assertLayout(page,insets,'after compose');
}

let preview,browser,browserVersion,logs='';
const results=[],failures=[];
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});
 for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>logs+=data.toString());
 let ready=false;
 for(let i=0;i<120;i++){
  try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}
  if(preview.exitCode!==null)throw Error('Preview exited before readiness');
  await pause(200);
 }
 assert(ready,'production preview becomes available');
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 browserVersion=browser.version();
 const cases=[
  ...[false,true].flatMap(dark=>[
   {name:'ipad-mini-portrait',width:744,height:1133,top:24,bottom:20,touch:true,dark,rotate:true},
   {name:'ipad-mini-landscape',width:1133,height:744,top:24,bottom:20,touch:true,dark},
  ]),
  {name:'iphone',width:390,height:844,top:47,bottom:34,touch:true,dark:true},
  {name:'desktop',width:1440,height:900,top:0,bottom:0,touch:false,dark:false},
 ];
 for(const config of cases){
  const label=`${config.name}-${config.dark?'dark':'light'}`;
  const page=await browser.newPage({viewport:{width:config.width,height:config.height},hasTouch:config.touch,locale:'de-DE'});
  page.setDefaultTimeout(12000);
  const errors=[],mutations=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
   await page.addInitScript(dark=>{localStorage.setItem('mailflare-theme',dark?'dark':'light');localStorage.setItem('mailflare-two-column-reading','off');},config.dark);
   await page.context().addCookies([{name:'mailflare-locale',value:'de',url:origin}]);
   await page.route('**/api/**',async route=>{
    const request=route.request();
    if(!['GET','HEAD'].includes(request.method()))mutations.push({path:new URL(request.url()).pathname,method:request.method()});
    await route.fulfill({contentType:'application/json',body:JSON.stringify(response(new URL(request.url())))});
   });
   const cdp=await page.context().newCDPSession(page);
   const insets={top:config.top,bottom:config.bottom,left:0,right:0};
   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets});
   await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});
   await page.locator('[data-message-row="viewport-0"]').waitFor();
   await page.waitForTimeout(550);
   assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('dark')),config.dark,'requested theme is active');
   const scroll=await exerciseScroll(page,cdp,insets,config.touch);
   await exerciseControls(page,insets);
   await page.screenshot({path:join(output,`${label}.png`)});
   let rotated;
   if(config.rotate){
    await page.setViewportSize({width:config.height,height:config.width});
    await page.waitForTimeout(300);
    rotated=await exerciseScroll(page,cdp,insets,config.touch);
    await exerciseControls(page,insets);
    await page.screenshot({path:join(output,`${label}-rotated.png`)});
    await page.setViewportSize({width:config.width,height:config.height});
    await page.waitForTimeout(300);
    await assertLayout(page,insets,'return to portrait');
   }
   assert.deepEqual(errors,[],'no browser runtime errors');
   assert(!mutations.some(item=>/\/send(?:\/|$)/.test(item.path)),'suite must not submit mail');
   const result={label,config,scroll,rotated,controls:true,errors};
   results.push(result);
   console.log(JSON.stringify({label,passed:true,initialHeaderY:scroll.before.header.y,scrolledHeaderY:scroll.scrolled.header.y,rootScroll:scroll.after.rootScroll,listScroll:scroll.scrolled.listScroll,rotated:!!rotated}));
  }catch(error){
   failures.push({label,message:error.message});
   console.error(`${label}: ${error.message}`);
   await page.screenshot({path:join(output,`${label}-failure.png`)}).catch(()=>{});
  }finally{await page.close();}
 }
 assert.deepEqual(failures,[],'all viewport scenarios pass');
}finally{
 await browser?.close();
 if(preview){
  preview.kill('SIGTERM');
  await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});
 }
 writeFileSync(join(output,'preview.log'),logs);
 writeFileSync(join(output,'results.json'),JSON.stringify({kind:'Chromium safe-area layout emulation; no native iOS chrome or software keyboard validation',browserVersion,results,failures},null,2));
 rmSync(temporary,{recursive:true,force:true});
}
