// Production router/assets; private APIs are synthetic and no live mailbox is read.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-display-browser-'));
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const origin=`http://127.0.0.1:${port}`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const folders=['inbox','invoices','promotions','social','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'];
let preview,browser,serverLog='';
function folderFor(url){const p=url.searchParams;if(p.has('folderId'))return 'label';if(p.get('category'))return p.get('category')==='primary'?'inbox':p.get('category');if(p.has('starred'))return 'starred';if(p.has('snoozed'))return 'snoozed';if(p.has('scheduled'))return 'scheduled';return p.get('status')||'all';}
function response(url){
 const path=url.pathname;
 if(path==='/api/auth/me')return {user:{id:'owner',name:'Test User',email:'owner@example.test',role:'user',hasAvatar:false},hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages'){const folder=folderFor(url);return {messages:[{id:folder+'-0',mailboxId:'box',direction:'inbound',status:'received',category:'primary',read:true,starred:false,fromAddr:'sender@example.test',toAddr:'owner@example.test',subject:folder+' first message',snippet:'Readable preview',labels:[],createdAt:'2026-10-15T12:00:00Z'}],total:1,limit:25,offset:0};}
 if(/^\/api\/messages\/mail-\d+$/.test(path))return {message:{...response(new URL('http://fixture/api/messages')).messages[0],id:path.split('/').at(-1)},body:{textBody:'Your receipt is now available.',htmlBody:null},attachments:[]};
 if(path==='/api/messages/counts')return {counts:{folders:Object.fromEntries(folders.map(folder=>[folder,{total:1,unread:0}])),customFolders:{work:{total:1,unread:0}},mailboxes:[]}};
 if(path==='/api/folders')return {folders:[{id:'work',name:'Work',color:'blue',parentId:null}]};
 if(path==='/api/agent/availability')return {enabled:false};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 return {folders:[],messages:[],jobs:[],job:null,hiddenLabelIds:[],ok:true};
}
async function until(check){for(let i=0;i<300;i++){if(check())return;await pause(50);}assert(check(),'background warm-up completes');}
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of [1440,1024,390,320]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<768}),errors=[],events=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('mailflare-column-width:message-list-height:owner','280'));
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url());events.push(url.pathname);
   const data=response(url);
   if(url.pathname==='/api/messages'){data.messages=Array.from({length:25},(_,index)=>({...data.messages[0],id:'mail-'+index,read:index!==0,fromAddr:'Sender <sender@example.test>',subject:'Message '+index,snippet:'Your receipt is now available.'}));data.total=25;}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});
  const row=page.locator('[data-message-row="mail-0"]'),read=page.locator('[data-message-row="mail-1"]');await row.waitFor();
  const toolbar=page.locator('.mail-mobile-list-toolbar'),selectAll=toolbar.getByRole('checkbox',{name:'Select all visible messages',exact:true});
  const center=box=>({x:box.x+box.width/2,y:box.y+box.height/2});
  if(width>=1024){
   const selectionCenter=center(await selectAll.boundingBox()),rowCenter=center(await row.locator('input[type=checkbox]').boundingBox()),search=page.getByRole('search'),searchCenter=center(await search.locator('svg.lucide-search').boundingBox());
   assert(Math.abs(selectionCenter.x-rowCenter.x)<1,'select-all aligns with row checkboxes');assert(Math.abs(selectionCenter.x-searchCenter.x)<1,'search icon shares the leading alignment');assert((await search.boundingBox()).width<=720);
   const buttons=toolbar.locator('.mail-bulk-toolbar button:visible');for(const button of await buttons.all()){const box=await button.boundingBox();assert.equal(box.width,40);assert.equal(box.height,40);assert(Math.abs(center(box).y-selectionCenter.y)<1,'action icons share one baseline');}
   const labels=await buttons.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')));assert.deepEqual(labels.slice(0,3),['Archive','Report spam','Delete']);assert(labels.includes('More actions'));
   await search.getByRole('textbox').focus();await page.waitForFunction(()=>getComputedStyle(document.querySelector('[role=search]')).backgroundColor==='rgb(255, 255, 255)');await search.getByRole('textbox').blur();await page.waitForFunction(()=>getComputedStyle(document.querySelector('[role=search]')).backgroundColor==='rgb(233, 234, 237)');
  }
  const headerActions=page.locator('[data-mail-header-actions]'),profile=headerActions.locator('[data-app-profile] > button'),gearBefore=headerActions.locator('#mail-quick-settings-toggle');assert((await gearBefore.boundingBox()).x<(await profile.boundingBox()).x,'profile stays at the far right');assert(Math.abs(center(await gearBefore.boundingBox()).y-center(await profile.boundingBox()).y)<1);
  await page.screenshot({path:`/tmp/mailflare-toolbar-${width}.png`});
  const initialHeight=(await row.boundingBox()).height;
  assert.equal(await row.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  assert.equal(await read.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(241, 243, 244)');
  if(width>=1024){const grid=page.locator('[data-reading-layout]'),list=grid.locator(':scope > aside'),pane=page.locator('[data-message-reading-pane]');assert(Math.abs((await list.boundingBox()).height-(await pane.boundingBox()).height)<2,'fresh panes divide available height equally');await page.setViewportSize({width,height:700});assert(Math.abs((await list.boundingBox()).height-(await pane.boundingBox()).height)<2,'default ratio adapts to screen height');await page.setViewportSize({width,height:900});}
  const gear=page.locator('#mail-quick-settings-toggle');assert((await gear.boundingBox()).width>=44);assert(await gear.isVisible());
  await row.evaluate(el=>window.__originalMailRow=el);
  assert.equal(await page.locator('[data-mail-quick-settings]').count(),0,'controls stay unloaded until first use');
  await gear.click();const panel=page.locator('[data-mail-quick-settings]');await panel.waitFor();
  assert.equal(await gear.getAttribute('aria-expanded'),'true');
  await panel.evaluate(el=>Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))));
  const panelTitle=panel.getByRole('heading',{name:'Quick settings',exact:true}),close=panel.getByRole('button',{name:'Close',exact:true});assert.equal(await close.count(),1,'one close control per panel');const titleBox=await panelTitle.boundingBox(),closeBox=await close.boundingBox();assert(closeBox.width>=44&&closeBox.height>=44);assert(Math.abs(center(titleBox).y-center(closeBox).y)<1,'title and close icon share the same centre '+JSON.stringify({width,titleBox,closeBox}));assert(closeBox.x>=titleBox.x+titleBox.width,'title leaves room for close control');
  const motion=await panel.evaluate(el=>({transition:getComputedStyle(el).transitionDuration,animation:getComputedStyle(el).animationName}));
  if(width>=1024)assert(motion.transition.includes('0.3s'));else assert.equal(motion.animation,'mail-quick-settings-sheet-show');
  const comfortablePanelHeight=(await row.boundingBox()).height;
  await panel.getByRole('radio',{name:/^Compact /}).check();
  await page.waitForFunction(()=>document.querySelector('[data-message-density]')?.dataset.messageDensity==='compact');
  const compactHeight=(await row.boundingBox()).height;assert(compactHeight<comfortablePanelHeight,JSON.stringify({width,compactHeight,comfortablePanelHeight}));
  assert(await row.evaluate(el=>window.__originalMailRow===el),'density change preserves the list DOM');
  if(width>=1024){const listWidth=(await page.locator('.mail-mobile-list').boundingBox()).width;assert(listWidth<=620?compactHeight>=52&&compactHeight<=60:compactHeight<=30,'narrow rows retain readable sender and subject lines');assert.equal(await row.locator('.mail-row-avatar').count(),0);const main=page.locator('main.mail-mobile-main');assert((await main.boundingBox()).x+(await main.boundingBox()).width<=(await panel.boundingBox()).x,'desktop panel sits beside the mailbox');}
  else {assert(compactHeight>=60);assert(await row.locator('.mail-row-snippet').isVisible());assert.equal(await page.locator('[data-mobile-compose]').isVisible(),false);const bounds=await panel.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1);assert(bounds.y+bounds.height<=901);}
  if(width>=1024){assert((await row.getByText('Message 0',{exact:true}).boundingBox()).width>=40,'message subject retains room next to quick settings');const mainBounds=await page.locator('main.mail-mobile-main').boundingBox();for(const button of await toolbar.locator('button:visible').all()){const box=await button.boundingBox();assert(box.x+box.width<=mainBounds.x+mainBounds.width+1,'quick settings leave toolbar controls reachable');}}
  await page.screenshot({path:`/tmp/mailflare-density-${width}.png`});
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.id==='mail-quick-settings-toggle');
  if(width>=1024){
   assert.equal(await panel.count(),1,'closing retains desktop controls for the exit transition');
   const slot=page.locator('[data-mail-quick-settings-slot]');assert.equal(Math.round((await slot.boundingBox()).width),0);
   await gear.click();await panel.waitFor();
   const sample=await slot.evaluate(el=>{const animations=el.getAnimations();for(const a of animations){a.pause();a.currentTime=150;}return {count:animations.length,width:el.getBoundingClientRect().width};});
   assert(sample.count>0&&sample.width>0&&sample.width<360,'warm open interpolates width: '+JSON.stringify(sample));
   await slot.evaluate(el=>el.getAnimations().forEach(a=>a.finish()));
   await panel.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));
   await close.click();await panel.waitFor({state:'hidden'});
   await page.emulateMedia({reducedMotion:'reduce'});await gear.click();await panel.waitFor();assert.equal(await panel.evaluate(el=>getComputedStyle(el).transitionDuration),'0s');assert.equal(await slot.evaluate(el=>getComputedStyle(el).transitionProperty),'none');await close.click();await panel.waitFor({state:'hidden'});await page.emulateMedia({reducedMotion:'no-preference'});
  }
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.waitForTimeout(350);const closedCompactHeight=(await row.boundingBox()).height;
  await page.reload({waitUntil:'domcontentloaded'});await row.waitFor();await page.waitForFunction(()=>document.querySelector('[data-message-density]')?.dataset.messageDensity==='compact');assert.equal((await row.boundingBox()).height,closedCompactHeight);
  await gear.click();await panel.waitFor();await page.waitForTimeout(350);assert(await panel.getByRole('radio',{name:/^Compact /}).isChecked());
  await panel.getByRole('radio',{name:/^Comfortable /}).check();await page.waitForFunction(()=>document.querySelector('[data-message-density]')?.dataset.messageDensity==='comfortable');assert.equal((await row.boundingBox()).height,comfortablePanelHeight);
  await close.click();await panel.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.id==='mail-quick-settings-toggle');
  if(width>=1024){await page.evaluate(()=>{localStorage.setItem('theme','dark');document.documentElement.classList.add('dark');});assert.notEqual(await row.evaluate(el=>getComputedStyle(el).backgroundColor),await read.evaluate(el=>getComputedStyle(el).backgroundColor));await page.screenshot({path:'/tmp/mailflare-density-dark.png'});}
  await selectAll.check();
  for(const button of await toolbar.locator('.mail-bulk-toolbar button:visible').all()){const box=await button.boundingBox();assert(box.x>=0&&box.x+box.width<=width,'selection controls stay on screen');if(width<768)assert(box.width>=44&&box.height>=44);}
  await toolbar.getByRole('button',{name:'More actions',exact:true}).click();await page.getByRole('menuitem',{name:'Archive',exact:true}).waitFor();await page.keyboard.press('Escape');await selectAll.uncheck();
  if(width<768){await page.context().addCookies([{name:'mailflare-locale',value:'de',url:origin}]);await page.goto(origin+'/inbox');await page.locator('[data-message-row=mail-0]').waitFor();await gear.click();await panel.waitFor();await panel.evaluate(el=>Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))));const title=panel.getByRole('heading',{name:'Schnelleinstellungen',exact:true}),deClose=panel.getByRole('button',{name:'Schließen',exact:true}),tbox=await title.boundingBox(),cbox=await deClose.boundingBox();assert(Math.abs(center(tbox).y-center(cbox).y)<1,'German mobile header aligns');assert(tbox.x+tbox.width<=cbox.x);const header=await panel.locator('[data-mail-quick-settings-header]').boundingBox(),legend=await panel.getByText('Nachrichtendichte',{exact:true}).boundingBox();assert(legend.y>=header.y+header.height+12,'content starts below the header with breathing room');await page.screenshot({path:`/tmp/mailflare-quick-settings-de-${width}.png`});await deClose.click();await panel.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.id==='mail-quick-settings-toggle');}
  assert.deepEqual(errors,[]);assert(!events.includes('/api/settings'),'quick settings do not fetch the settings form');
  console.log(JSON.stringify({width,initialHeight,compactHeight,persisted:true,smoothSettingsMotion:true,reducedMotion:width>=1024,readStatusColors:true,defaultHalfSplit:width>=1024,errors}));await page.close();
 }

}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-display-browser-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
