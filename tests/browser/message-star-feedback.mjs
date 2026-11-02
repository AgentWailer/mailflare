// Visual review of production routes/assets with synthetic APIs: no real mail is read or sent.
// Run after npm run build. VISUAL_OUTPUT selects the screenshot directory.
// Run preview-based suites sequentially: workerd uses a shared inspector port.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(tmpdir(),'mailflare-star-browser-'));
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

const out=process.env.VISUAL_OUTPUT||'/tmp/mailflare-star-feedback';mkdirSync(out,{recursive:true});
const names=['Mara Schneider','Kundenservice Beispiel GmbH','Atelier Nord — Design & Architektur','Buchhandlung am Markt','Projektteam Europa','Reisebüro Horizonte'];
const subjects=['Unser Termin am Donnerstag: Unterlagen und nächste Schritte','Ihre Rechnung für Oktober 2026 steht bereit','Entwurf zur Freigabe: Die neue Website für unser gemeinsames Projekt','Ihre Bestellung ist unterwegs','Rückfrage zu Ihrem Angebot – bitte bis Freitag bestätigen','Reisebestätigung und Fahrkarten für Ihre Fahrt nach Hamburg'];
const snippets=['Hallo, anbei die besprochenen Unterlagen. Wir freuen uns auf den Austausch.','Vielen Dank für Ihren Auftrag. Die vollständige Rechnung finden Sie im Anhang.','Die überarbeitete Version ist fertig. Besonders beim mobilen Layout gibt es Verbesserungen.'];
const labels=[{id:'work',name:'Kundenprojekte und Zusammenarbeit',color:'#2563eb',parentId:null},{id:'docs',name:'Unterlagen',color:'#16a34a',parentId:null}];
const messages=Array.from({length:18},(_,i)=>({id:'mail-'+i,mailboxId:'box',direction:'inbound',status:'received',category:'primary',read:i%3===1,starred:i===2,fromAddr:`${names[i%6]} <sender${i}@example.test>`,toAddr:'owner@example.test',subject:subjects[i%6],snippet:snippets[i%3],labels:i%4===0?labels:[],attachmentCount:i%3===0?1:0,createdAt:new Date(Date.UTC(2026,9,28,14,45-i*4)).toISOString()}));
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});
 for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;
 for(let i=0;i<120;i++){
  try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}
  if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);
 }
 assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const {width,density,layout='bottom',dark=false} of [
  {width:1440,density:'comfortable'}, {width:1440,density:'compact'},
  {width:1440,density:'comfortable',layout:'right'}, {width:390,density:'comfortable'},
  {width:320,density:'compact'}, {width:390,density:'comfortable',dark:true}
 ].filter(config=>!process.env.STAR_VISUAL_RECHECK||config.layout==='right'||config.dark)){
  const page=await browser.newPage({viewport:{width,height:width<768?844:900},hasTouch:width<768,locale:'de-DE'}),errors=[],attempts=[];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({density,layout,dark})=>{
   localStorage.setItem('mailflare-message-density',density);
   localStorage.setItem('mailflare-reading-layout',layout);
   if(dark)localStorage.setItem('mailflare-theme','dark');
  },{density,layout,dark});
  await page.context().addCookies([{name:'mailflare-locale',value:'de',url:origin}]);
  let releaseFailure;
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url()),path=url.pathname;let data=response(url);
   if(path==='/api/folders')data={folders:labels};
   if(path==='/api/messages'){
    const list=folderFor(url)==='scheduled' ? ['unknown','failed','sending'].map((status,i)=>({...messages[i],id:'scheduled-'+i,direction:'outbound',status:'draft',scheduledAt:'2026-11-03T12:00:00Z',deliveryStatus:status})) : messages;
    data={messages:list,total:list.length,limit:Number(url.searchParams.get('limit')||25),offset:0};
   }
   if(path==='/api/messages/mail-0/star'){
    const desired=JSON.parse(route.request().postData()).starred;attempts.push(desired);
    if(attempts.length===1)await new Promise(resolve=>releaseFailure=resolve);
    const fails=attempts.length===1||attempts.length===3;
    await route.fulfill({status:fails?503:200,contentType:'application/json',body:JSON.stringify(fails?{error:'Synthetic failure'}:{starred:desired})});return;
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});
  const row=page.locator('[data-message-row="mail-0"]');await row.waitFor();
  await page.waitForFunction(density=>document.querySelector('[data-message-density]')?.dataset.messageDensity===density,density);
  // Allow the side reader/layout preference to settle before testing hit targets.
  await page.waitForTimeout(300);
  const star=()=>row.getByRole('button',{name:/^(Nicht markiert|Markiert|Markierung wird gespeichert …)$/});
  if(width>=768){await row.hover();const actions=row.locator('.mail-row-actions');if(await actions.count())await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-message-row="mail-0"] .mail-row-actions')).opacity==='1');}
  const hit=await star().evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
  assert(hit,'the star remains directly clickable while hover actions are shown');
  const shot=async name=>page.screenshot({path:`${out}/${width}-${density}-${layout}${dark?'-dark':''}-${name}.png`});
  await shot('hover');
  await star().click();
  await row.getByRole('button',{name:'Markierung wird gespeichert …',exact:true}).waitFor();
  assert(await star().isDisabled(),'pending stars prevent duplicate requests');
  await star().evaluate(el=>{el.click();el.click();});assert.equal(attempts.length,1);
  releaseFailure();
  const alert=page.getByRole('alert').filter({hasText:'Die Markierung für'});await alert.waitFor();
  assert((await alert.innerText()).includes(subjects[0]),'failure identifies the affected message');
  assert.equal(await star().getAttribute('aria-pressed'),'false','failed operation does not pretend to succeed');
  const box=await alert.boundingBox();assert(box.x>=0&&box.x+box.width<=width+1,'error and recovery fit the viewport');
  const textBox=await alert.locator('span').first().boundingBox();assert(textBox.width>=Math.min(box.width-32,224),'error text has readable width even in a narrow desktop reading pane');
  await shot('error');
  await alert.getByRole('button',{name:'Erneut versuchen',exact:true}).click();
  await row.getByRole('button',{name:'Markiert',exact:true}).waitFor();await alert.waitFor({state:'hidden'});
  assert.deepEqual(attempts,[true,true],'retry sends the same target state, never a second toggle');
  await star().click();await alert.waitFor();assert.equal(await star().getAttribute('aria-pressed'),'true');
  await alert.getByRole('button',{name:'Erneut versuchen',exact:true}).click();
  await row.getByRole('button',{name:'Nicht markiert',exact:true}).waitFor();await alert.waitFor({state:'hidden'});
  assert.deepEqual(attempts,[true,true,false,false]);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.goto(origin+'/scheduled',{waitUntil:'domcontentloaded'});
  for(const status of ['unknown','failed','sending'])await page.locator(`[data-delivery-status="${status}"]`).waitFor();
  assert((await page.locator('[data-delivery-status="unknown"]').innerText()).includes('Zustellung unklar'));
  await page.waitForFunction(()=>[...document.querySelectorAll('[aria-live="polite"][aria-label="Wird geladen"]')].every(el=>getComputedStyle(el).opacity==='0'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('scheduled');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,density,layout,dark,starClickable:true,retryTargets:attempts,scheduledStates:true,errors}));await page.close();
 }
}finally{
 await browser?.close();
 if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}
 writeFileSync(join(out,'preview.log'),serverLog);rmSync(temporary,{recursive:true,force:true});
}
