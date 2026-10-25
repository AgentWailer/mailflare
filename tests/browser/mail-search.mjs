// Production UI/router/assets; all private APIs use synthetic fixtures.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-search-browser-'));
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const origin=`http://127.0.0.1:${port}`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const folders=['inbox','invoices','promotions','social','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'];
const mail=(id,status='received',direction='inbound')=>({id,mailboxId:'box',direction,status,category:'primary',read:false,starred:false,fromAddr:'Sender <sender@example.test>',toAddr:'owner@example.test',subject:'Crossfolder '+id,snippet:'Readable content',labels:[],createdAt:'2026-10-25T12:00:00Z'});
const hits=[mail('receipt'),mail('archive','archived'),mail('sent','sent','outbound'),mail('draft','draft','outbound'),mail('trash','trash')];
let preview,browser,serverLog='';
function response(url){
 const path=url.pathname;
 if(path==='/api/auth/me')return {user:{id:'owner',name:'Test User',email:'owner@example.test',role:'user',hasAvatar:false},hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages'){const query=url.searchParams.get('q'),messages=query?[...hits,...(/in:anywhere/.test(query)?[mail('spam','spam')]:[])]:[mail('initial')];return {messages,total:messages.length,limit:25,offset:0};}
 if(path==='/api/messages/counts')return {counts:{folders:Object.fromEntries(folders.map(folder=>[folder,{total:1,unread:0}])),customFolders:{work:{total:1,unread:0}},mailboxes:[]}};
 if(path==='/api/folders')return {folders:[{id:'work',name:'Work',color:'blue',parentId:null}]};
 if(path==='/api/agent/availability')return {enabled:false};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 if(path==='/api/messages/archive')return {message:mail('archive','archived'),body:{textBody:'Archived receipt content',htmlBody:null},attachments:[]};
 return {folders:[],messages:[],jobs:[],job:null,hiddenLabelIds:[],ok:true};
}
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of [320,390,1440])for(const start of ['/inbox','/spam','/sent','/drafts','/folders/work']){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<768}),errors=[],searchRequests=[],navigationRequests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/api/messages'&&url.searchParams.has('q'))searchRequests.push(url);if(url.pathname==='/api/messages/navigation')navigationRequests.push(url);await route.fulfill({contentType:'application/json',body:JSON.stringify(response(url))});});
  try{
   await page.goto(origin+start,{waitUntil:'domcontentloaded'});await page.locator('[data-message-row="initial"]').waitFor();
   const search=page.locator('[data-mail-search-input]');await search.fill('Crossfolder');await page.locator('[data-message-row="archive"]').waitFor();
   assert.equal(await page.locator('[data-message-row]').count(),hits.length);assert.equal(await page.locator('[data-message-row="spam"]').count(),0);assert.equal(await page.locator('[data-inbox-categories]').count(),0);
   assert.equal(await page.locator('[data-message-row="archive"] a').first().getAttribute('href'),'/all/archive');assert.equal(await page.locator('[data-message-row="draft"] a').first().getAttribute('href'),'/drafts/draft');
   await page.getByRole('button',{name:'Advanced search',exact:true}).click();let dialog=page.getByRole('dialog');await dialog.getByRole('checkbox',{name:'Include spam',exact:true}).check();assert.equal(await page.locator('[data-message-row="spam"]').count(),0,'editing options never applies a search before submission');await dialog.getByRole('button',{name:'Search',exact:true}).click();await page.locator('[data-message-row="spam"]').waitFor();assert.equal(await search.inputValue(),'Crossfolder in:anywhere');
   await page.getByRole('button',{name:'Advanced search',exact:true}).click();dialog=page.getByRole('dialog');assert(await dialog.getByRole('checkbox',{name:'Include spam',exact:true}).isChecked());await dialog.getByRole('checkbox',{name:'Include spam',exact:true}).uncheck();
   if(start==='/inbox')await page.screenshot({path:`/tmp/mailflare-search-details-${width}.png`});
   await dialog.getByRole('button',{name:'Search',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-message-row="spam"]'));assert.equal(await search.inputValue(),'Crossfolder');
   for(const url of searchRequests){assert.equal(url.searchParams.get('mailboxId'),'box');for(const key of ['status','direction','category','folderId','starred','snoozed','scheduled'])assert.equal(url.searchParams.has(key),false,key+' must not constrain global search');}
   if(start==='/inbox'){
    await page.locator('[data-message-row="archive"] a').first().click();await page.waitForURL('**/all/archive');await page.getByText('Archived receipt content',{exact:true}).waitFor();
    assert(navigationRequests.some(url=>url.searchParams.get('q')==='Crossfolder'),'reader navigation retains the search query and spam exclusion');
    await page.goBack();await page.locator('[data-message-row="archive"]').waitFor();
   }
   await page.getByRole('button',{name:'Clear search',exact:true}).click();await page.locator('[data-message-row="initial"]').waitFor();assert.equal(new URL(page.url()).pathname,start);await page.getByRole('button',{name:'Advanced search',exact:true}).click();assert.equal(await page.getByRole('dialog').getByRole('checkbox',{name:'Include spam',exact:true}).isChecked(),false,'clearing search resets explicit spam inclusion');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile search and detail controls do not overflow');assert.deepEqual(errors,[]);
   console.log(JSON.stringify({width,start,allFolders:true,spamOptInOnly:true,clearRestoresFolder:true,safeResultLinks:true,noOverflow:true}));
  }catch(error){await page.screenshot({path:'/tmp/mailflare-search-failure.png'});console.error(JSON.stringify({width,start,errors,text:(await page.locator('body').innerText()).slice(-3000)}));throw error;}finally{await page.close();}
 }
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-search-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
