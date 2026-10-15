// Production router/assets; private APIs are synthetic and no live mailbox is read.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-preload-browser-'));
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
 for(const width of [1440,390])for(const pendingClick of [true,false]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[],events=[];let releaseInbox,releaseAll,allReady=false;
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/TypeError|Minified React error|Cannot read/.test(message.text()))errors.push(message.text());});
  await page.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),preload=request.headers()['x-mailflare-preload']==='1';events.push({path:url.pathname,query:url.search,preload,folder:url.pathname==='/api/messages'?folderFor(url):null,method:request.method()});
   if(pendingClick&&url.pathname==='/api/messages'&&folderFor(url)==='inbox')await new Promise(resolve=>releaseInbox=resolve);
   if(pendingClick&&preload&&url.pathname==='/api/messages'&&folderFor(url)==='all')await new Promise(resolve=>releaseAll=resolve);
   await pause(100);await route.fulfill({contentType:'application/json',body:JSON.stringify(response(url))}).catch(()=>{});if(preload&&url.pathname==='/api/messages'&&folderFor(url)==='all')allReady=true;
  });
  await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});
  if(pendingClick){await until(()=>!!releaseInbox);await pause(1100);assert.equal(events.filter(event=>event.preload).length,0,'startup never competes with the visible list');releaseInbox();}
  await page.locator('[data-message-row="inbox-0"]').waitFor();
  if(pendingClick){await until(()=>!!releaseAll);assert(await page.locator('[data-message-row="inbox-0"]').isVisible(),'pending preload leaves inbox usable');}
  else {await until(()=>allReady);await until(()=>events.some(event=>event.preload&&event.folder==='label'));await pause(200);}
  const automatic=events.filter(event=>event.preload);assert.equal(automatic[0].folder,'all','All mail is first');
  if(width<768)await page.getByRole('button',{name:'Open menu',exact:true}).click();
  const allLink=page.locator('a[href="/all"]:visible').first();await allLink.evaluate(link=>link.addEventListener('click',()=>{window.__allClickAt=performance.now();},{capture:true,once:true}));
  await allLink.click();await page.waitForURL('**/all');
  if(pendingClick){assert.equal(events.filter(event=>event.folder==='all').length,1,'foreground click shares the pending low-priority request');releaseAll();}
  await page.locator('[data-message-row="all-0"]').waitFor();const clickMs=Math.round(await page.evaluate(()=>performance.now()-window.__allClickAt));
  assert.equal(events.filter(event=>event.folder==='all').length,1,'cached first visit sends no duplicate list request');
  if(!pendingClick){assert(clickMs<1000,`warm first visit renders within budget after the actual click (${clickMs} ms)`);assert.equal(new Set(events.filter(event=>event.path==='/api/messages').map(event=>event.folder)).size,15,'all system folders plus label have first pages');}
  assert(!events.some(event=>/^\/api\/messages\/(?!counts|bulk-jobs)/.test(event.path)),'warming never fetches message bodies');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,pendingClick,allFirst:true,visibleListHasPriority:true,singleAllRequest:true,clickMs,allFoldersWarm:!pendingClick}));await page.close();
 }
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-preload-browser-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
