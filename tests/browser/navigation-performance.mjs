// Real production router/assets, synthetic private APIs. No live mail is accessed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const baseline=process.env.MAILFLARE_MENU_BASELINE==='1',phase=baseline?'before':'after';
const en=JSON.parse(readFileSync('src/lib/i18n/en.json','utf8'));
const temporary=mkdtempSync(join(tmpdir(),'mailflare-navigation-'));
const portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const origin=`http://127.0.0.1:${port}`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let preview,browser,serverLog='';
const user={id:'owner',name:'Test User',email:'owner@example.test',role:'admin',isPrimaryAdmin:true,canManageDomains:true,canManageUsers:true,canManageMailboxes:true,canForwardEmail:true,hasAvatar:false,timeZone:'Europe/Berlin',resetEmail:null,forwardingEmail:null,keyboardShortcutsEnabled:true};
const mailbox={id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']};
const domain={id:'domain',hostname:'example.test',status:'active',routingEnabled:true,sendingEnabled:true,sendingProvider:'cloudflare',receivingProvider:'cloudflare',createdAt:'2026-10-01T00:00:00Z'};
const counts={folders:Object.fromEntries(['inbox','promotions','social','invoices','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'].map(key=>[key,{total:1,unread:0}])),customFolders:{},mailboxes:[]};
function response(url){const path=url.pathname;
 if(path==='/api/auth/me')return {user,hasMailboxes:true,isSetup:true,managesDns:true};
 if(path==='/api/mailboxes')return {mailboxes:[mailbox]};
 if(path==='/api/messages')return {messages:[{id:'mail',mailboxId:'box',userId:'owner',direction:'inbound',status:'received',category:url.searchParams.get('category')||'primary',read:true,starred:false,fromAddr:'sender@example.test',toAddr:'owner@example.test',subject:'Navigation sample',snippet:'A readable preview',createdAt:'2026-10-15T08:00:00Z',labels:[]}],total:1,limit:25,offset:0};
 if(path==='/api/messages/counts')return {counts};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 if(path==='/api/agent/availability')return {enabled:false};
 if(path==='/api/domains')return {domains:[domain],dns:{}};
 if(path==='/api/admin/agent')return {assistantEnabled:false,cloudflareAvailable:true,config:{provider:'cloudflare',preset:'openai',baseUrl:'',models:[],rates:{},hasKey:false}};
 if(path==='/api/backups')return {backups:[],settings:{enabled:false,scheduleType:'weekly',scheduleValue:0,retentionEnabled:false,retentionDays:30,excludedTableGroups:[]},configuration:{configured:true,missing:[],rescue:true,recoveryKeyConfigured:true}};
 if(path==='/api/admin/general')return {settings:{outboundAttachmentMaxMb:25,driveStorageLimitBytes:null}};
 if(path==='/api/drive/items')return {items:[],path:[],role:'owner',storageUsed:0,storageLimit:null};
 if(path==='/api/drive/storage')return {storageUsed:0,storageLimit:null};
 if(path==='/api/calendar/events')return {events:[]};
 if(path==='/api/settings/paperless')return {available:true,settings:{enabled:false,labelId:null},connection:null,labels:[],jobs:[],counts:[]};
 if(path==='/api/settings/mfa')return {enabled:false,recoveryCodesLeft:0};
 if(path.startsWith('/api/mailboxes/'))return {mailbox:{...mailbox,signature:'',autoReplyEnabled:false,autoReplySubject:'',autoReplyBody:''}};
 return {folders:[],jobs:[],job:null,accounts:[],apiKeys:[],rules:[],tokens:[],messages:[],hiddenLabelIds:[],webhooks:[],activity:[],events:[],models:[],enabled:false,ok:true};
}
const results=[];
async function screen(width,path){
 const page=await browser.newPage({viewport:{width,height:900}}),events=[],errors=[];
 await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/TypeError|Minified React error|Cannot read/.test(message.text()))errors.push(message.text());});page.on('request',request=>events.push({at:Date.now(),path:new URL(request.url()).pathname,query:new URL(request.url()).search,prefetch:request.headers()['next-router-prefetch'],rsc:request.headers().rsc,type:request.resourceType(),method:request.method()}));
 await page.route('**/api/**',async route=>{await pause(100);await route.fulfill({contentType:'application/json',body:JSON.stringify(response(new URL(route.request().url())))}).catch(()=>{});});
 const cdp=await page.context().newCDPSession(page),scripts=new Map();cdp.on('Network.responseReceived',event=>{if(event.type==='Script')scripts.set(event.requestId,{name:new URL(event.response.url).pathname,bytes:0});});cdp.on('Network.loadingFinished',event=>{if(scripts.has(event.requestId))scripts.get(event.requestId).bytes=event.encodedDataLength;});await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:1500000,uploadThroughput:750000});
 const start=Date.now();await page.goto(origin+path,{waitUntil:'domcontentloaded',timeout:60000});await page.locator('[data-settings-section]').first().waitFor({timeout:30000});await pause(800);
 const resources=[...scripts.values()];assert(resources.length>0&&resources.some(resource=>resource.bytes>0),'CDP records real transferred JavaScript despite the fixed screenshot clock');
 const result={width,path,readyMs:Date.now()-start,jsBytes:resources.reduce((sum,entry)=>sum+entry.bytes,0),jsRequests:resources.length,apiRequests:events.filter(event=>event.path.startsWith('/api/')).length,automaticRoutePrefetch:events.filter(event=>event.rsc&&event.prefetch).length};
 const advanced=resources.filter(entry=>/\/(?:mailbox-signature-form|rich-text-utils|paperless-settings|mail-sorting-settings|spam-filter-settings)-/.test(entry.name));
 if(!baseline){assert(result.jsBytes<1_250_000,'closed account and inbox settings stay within the 1.25 MB JavaScript budget');assert.equal(advanced.length,0,'closed forms must not download rich text/sorting/integration code');assert.equal(result.automaticRoutePrefetch,0,'settings menu must not prefetch other pages');assert.equal(events.filter(event=>event.path==='/api/auth/me').length,1,'settings reuse live guard identity');assert.equal(events.filter(event=>event.path==='/api/folders').length,1,'sidebar and toolbars share folder definitions');}
 await page.screenshot({path:`/tmp/mailflare-navigation-${phase}-${width}-${path.split('/').at(-1)}.png`});assert.deepEqual(errors,[]);results.push(result);console.log(JSON.stringify(result));return {page,events,errors};
}
async function menu(page,href){await page.getByRole('button',{name:en['account.openMenu'],exact:true}).click();const link=page.locator(`a[href="${href}"]:visible`).last();await link.waitFor();await link.click();await page.waitForURL('**'+href);}
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/settings/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of (process.env.MAILFLARE_ADMIN_ONLY?[1440]:[1440,390]))for(const path of (process.env.MAILFLARE_ADMIN_ONLY?['/settings/account']:['/settings/account','/settings/inbox'])){
  const {page,events,errors}=await screen(width,path);
  if(!baseline&&path.endsWith('/inbox')){assert.equal(events.filter(event=>event.path==='/api/settings/paperless').length,0);await page.locator('#paperless > h3 > button').click();await page.locator('#paperless-content input').first().waitFor();assert.equal(events.filter(event=>event.path==='/api/settings/paperless').length,1);await page.locator('#paperless-content input').first().fill('https://documents.example.test');await page.locator('#paperless > h3 > button').click();await page.locator('#paperless > h3 > button').click();assert.equal(await page.locator('#paperless-content input').first().inputValue(),'https://documents.example.test');}
  if(width===1440&&path.endsWith('/account')){
   for(const next of (process.env.MAILFLARE_ADMIN_ONLY?[]:['security','inbox','rules','api-keys','app-passwords','import','export','account'])){const start=Date.now();await page.locator(`a[href="/settings/${next}"]:visible`).first().click();await page.waitForURL('**/settings/'+next);await page.locator('main h1').first().waitFor();await pause(250);console.log(JSON.stringify({menu:'/settings/'+next,ms:Date.now()-start}));}
   await menu(page,'/admin');await page.getByRole('heading').first().waitFor();
   let releaseDns,held=false;if(!baseline)await page.route('**/api/domains?includeDns=true',async route=>{held=true;await new Promise(resolve=>releaseDns=resolve);await route.fulfill({contentType:'application/json',body:JSON.stringify({domains:[domain],dns:{}})}).catch(()=>{});});
   const start=Date.now();await page.locator('a[href="/domains"]:visible').first().click();await page.getByText('example.test',{exact:true}).first().waitFor({timeout:20000});
   if(!baseline){for(let i=0;i<50&&!held;i++)await pause(20);assert(held&&releaseDns,'DNS audit starts separately');console.log(JSON.stringify({domainsUsableBeforeDns:true,ms:Date.now()-start}));}
   if(releaseDns)releaseDns();else await page.unroute('**/api/domains?includeDns=true');
   if(!baseline)for(const href of ['/mailboxes','/routing','/webhooks','/api-keys','/general','/agent','/accounts','/activity','/backups','/branding','/licenses']){
    const started=Date.now();
    if(["/branding","/licenses"].includes(href)){const section=page.getByRole("button",{name:en["admin.nav.product"],exact:true});if(await section.count()&&await section.getAttribute("aria-expanded")==="false")await section.click();}
    const target=page.locator(`a[href="${href}"]`).first();await target.scrollIntoViewIfNeeded();await target.click();await page.waitForURL('**'+href);await page.locator('main').getByRole('heading').first().waitFor();await pause(350);assert.deepEqual(errors,[]);console.log(JSON.stringify({adminMenu:href,ms:Date.now()-started}));
   }
   for(const href of ['/drive','/calendar','/inbox']){const start=Date.now();await menu(page,href);if(href==='/inbox')await page.getByText('Navigation sample',{exact:true}).first().waitFor();else await page.locator('main').first().waitFor();await pause(300);console.log(JSON.stringify({menu:href,ms:Date.now()-start}));}
  }
  assert.deepEqual(errors,[]);assert(!events.some(event=>event.method!=='GET'&&!(event.method==='POST'&&event.path==='/api/admin/agent/models')),'navigation and expansion never write data (model catalog POST is read-only)');await page.close();
 }
 writeFileSync(`/tmp/mailflare-navigation-${phase}.json`,JSON.stringify(results,null,2));
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync(`/tmp/mailflare-navigation-${phase}-preview.log`,serverLog);rmSync(temporary,{recursive:true,force:true});}
