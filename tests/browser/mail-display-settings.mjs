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
 for(const width of [1440,390,320]){
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
  const initialHeight=(await row.boundingBox()).height;
  assert.equal(await row.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  assert.equal(await read.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(241, 243, 244)');
  if(width>=1024){const grid=page.locator('[data-reading-layout]'),list=grid.locator(':scope > aside'),pane=page.locator('[data-message-reading-pane]');assert(Math.abs((await list.boundingBox()).height-(await pane.boundingBox()).height)<2,'fresh panes divide available height equally');await page.setViewportSize({width,height:700});assert(Math.abs((await list.boundingBox()).height-(await pane.boundingBox()).height)<2,'default ratio adapts to screen height');await page.setViewportSize({width,height:900});}
  const gear=page.locator('#mail-quick-settings-toggle');assert((await gear.boundingBox()).width>=44);assert(await gear.isVisible());
  await row.evaluate(el=>window.__originalMailRow=el);
  await gear.click();const panel=page.locator('[data-mail-quick-settings]');await panel.waitFor();
  assert.equal(await gear.getAttribute('aria-expanded'),'true');
  await panel.getByRole('radio',{name:/^Compact /}).check();
  await page.waitForFunction(()=>document.querySelector('[data-message-density]')?.dataset.messageDensity==='compact');
  const compactHeight=(await row.boundingBox()).height;assert(compactHeight<initialHeight,JSON.stringify({width,compactHeight,initialHeight}));
  assert(await row.evaluate(el=>window.__originalMailRow===el),'density change preserves the list DOM');
  if(width>=1024){assert(compactHeight<=30);assert.equal(await row.locator('.mail-row-avatar').count(),0);const main=page.locator('main.mail-mobile-main');assert((await main.boundingBox()).x+(await main.boundingBox()).width<=(await panel.boundingBox()).x,'desktop panel sits beside the mailbox');}
  else {assert(compactHeight>=60);assert(await row.locator('.mail-row-snippet').isVisible());assert.equal(await page.locator('[data-mobile-compose]').isVisible(),false);const bounds=await panel.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1);assert(bounds.y+bounds.height<=901);}
  await page.screenshot({path:`/tmp/mailflare-density-${width}.png`});
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.id==='mail-quick-settings-toggle');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.reload({waitUntil:'domcontentloaded'});await row.waitFor();await page.waitForFunction(()=>document.querySelector('[data-message-density]')?.dataset.messageDensity==='compact');assert.equal((await row.boundingBox()).height,compactHeight);
  await gear.click();await panel.waitFor();assert(await panel.getByRole('radio',{name:/^Compact /}).isChecked());
  await panel.getByRole('radio',{name:/^Comfortable /}).check();await page.waitForFunction(()=>document.querySelector('[data-message-density]')?.dataset.messageDensity==='comfortable');assert.equal((await row.boundingBox()).height,initialHeight);
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  if(width>=1024){await page.evaluate(()=>{localStorage.setItem('theme','dark');document.documentElement.classList.add('dark');});assert.notEqual(await row.evaluate(el=>getComputedStyle(el).backgroundColor),await read.evaluate(el=>getComputedStyle(el).backgroundColor));await page.screenshot({path:'/tmp/mailflare-density-dark.png'});}
  assert.deepEqual(errors,[]);assert(!events.includes('/api/settings'),'quick settings do not fetch the settings form');
  console.log(JSON.stringify({width,initialHeight,compactHeight,persisted:true,readStatusColors:true,defaultHalfSplit:width>=1024,errors}));await page.close();
 }

}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-display-browser-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
