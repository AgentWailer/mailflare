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

const out=process.env.VISUAL_OUTPUT||'/tmp/mailflare-visual';mkdirSync(out,{recursive:true});
const names=['Mara Schneider','Kundenservice Beispiel GmbH','Atelier Nord — Design & Architektur','Buchhandlung am Markt','Projektteam Europa','Reisebüro Horizonte'];
const subjects=['Unser Termin am Donnerstag: Unterlagen und nächste Schritte','Ihre Rechnung für Oktober 2026 steht bereit','Entwurf zur Freigabe: Die neue Website für unser gemeinsames Projekt','Ihre Bestellung ist unterwegs','Rückfrage zu Ihrem Angebot – bitte bis Freitag bestätigen','Reisebestätigung und Fahrkarten für Ihre Fahrt nach Hamburg'];
const snippets=['Hallo, anbei die besprochenen Unterlagen. Wir freuen uns auf den Austausch.','Vielen Dank für Ihren Auftrag. Die vollständige Rechnung finden Sie im Anhang.','Die überarbeitete Version ist fertig. Besonders beim mobilen Layout gibt es Verbesserungen.'];
const labels=[{id:'work',name:'Kundenprojekte und Zusammenarbeit',color:'#2563eb',parentId:null},{id:'docs',name:'Unterlagen',color:'#16a34a',parentId:null}];
const messages=Array.from({length:18},(_,i)=>({id:'mail-'+i,mailboxId:'box',direction:'inbound',status:'received',category:'primary',read:i%3===1,starred:i===2,fromAddr:`${names[i%6]} <sender${i}@example.test>`,toAddr:'owner@example.test',subject:subjects[i%6],snippet:snippets[i%3],labels:i%4===0?labels:[],attachmentCount:i%3===0?1:0,createdAt:new Date(Date.UTC(2026,9,28,14,45-i*4)).toISOString()}));
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const {width,dark=false} of [{width:1440},{width:1024},{width:768},{width:390},{width:320},{width:1440,dark:true},{width:1024,dark:true},{width:390,dark:true}]){
  const page=await browser.newPage({viewport:{width,height:width<768?844:900},hasTouch:width<1024,locale:'de-DE'}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  if(dark)await page.addInitScript(()=>localStorage.setItem('mailflare-theme','dark'));
  await page.context().addCookies([{name:'mailflare-locale',value:'de',url:origin}]);
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url()),path=url.pathname;let data=response(url);
   if(path==='/api/folders')data={folders:labels};
   if(path==='/api/messages')data={messages,total:messages.length,limit:25,offset:0};
   if(/^\/api\/messages\/mail-\d+$/.test(path)){const message=messages.find(m=>m.id===path.split('/').at(-1));data={message,body:{textBody:'Guten Tag,\n\nvielen Dank für das freundliche Gespräch. Anbei die besprochenen Unterlagen. Bitte geben Sie uns bis Freitag Bescheid.\n\nHerzliche Grüße\nMara Schneider',htmlBody:null},attachments:[]};}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});const row=page.locator('[data-message-row="mail-0"]');await row.waitFor();
  await page.waitForTimeout(1400);
  const shot=async name=>{await page.screenshot({path:`${out}/${width}${dark?'-dark':''}-${name}.png`});};
  await shot('inbox');
  if(process.env.MENU_REVIEW){
   if(width<768)await page.getByRole('button',{name:'Menü öffnen',exact:true}).click();
   const sidebar=page.locator('aside').filter({has:page.locator('a[href="/inbox"]')}).first();
   await page.waitForTimeout(300);await shot('menu');
   const more=sidebar.locator('[data-mail-more-folders]');
   assert.equal(await more.getAttribute('aria-expanded'),'false');
   assert(await sidebar.locator('a[href="/drafts"]').isVisible());
   assert.equal(await sidebar.locator('a[href="/spam"]').count(),0);
   await more.click();assert(await sidebar.locator('a[href="/spam"]').isVisible());await shot('menu-expanded');await more.click();
   const utilities=sidebar.locator('a[href="/settings/account"]');const ub=await utilities.boundingBox();assert(ub.y+ub.height<= (width<768?844:900));
   if(width<768){await sidebar.getByRole('button',{name:'Schließen',exact:true}).click();await page.waitForTimeout(250);assert.equal(await sidebar.getAttribute('aria-hidden'),'true');await page.getByRole('button',{name:'Menü öffnen',exact:true}).click();await page.keyboard.press('Escape');await page.waitForTimeout(250);assert.equal(await sidebar.getAttribute('aria-hidden'),'true');await page.getByRole('button',{name:'Menü öffnen',exact:true}).click();}
   await sidebar.locator('a[href="/folders/work"]').scrollIntoViewIfNeeded();await shot('menu-labels');
   if(width<768){await sidebar.locator('a[href="/folders/work"]').click();await page.waitForURL('**/folders/work');await page.waitForTimeout(300);assert.equal(await sidebar.getAttribute('aria-hidden'),'true');}
   if(width<768)await page.getByRole('button',{name:'Menü öffnen',exact:true}).click();
   if(await more.getAttribute('aria-expanded')==='false')await more.click();
   await sidebar.locator('a[href="/archived"]').click();await page.waitForURL('**/archived');
   if(width<768)await page.getByRole('button',{name:'Menü öffnen',exact:true}).click();
   if(await more.getAttribute('aria-expanded')==='true')await more.click();
   assert(await sidebar.locator('a[href="/archived"][aria-current="page"]').isVisible(),'active secondary folder is never hidden');
   if(width>=768){await row.waitFor();await page.waitForTimeout(350);await sidebar.locator('a[href="/sent"]').hover();await page.waitForTimeout(200);await shot('menu-hover');}
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
   console.log(JSON.stringify({width,dark,menu:true,errors}));await page.close();continue;
  }
  if(width>=1024){await row.hover();await page.waitForTimeout(250);for(const button of await row.locator('.mail-row-actions button').all())assert(await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'hover actions are clickable');await shot('hover');await page.mouse.move(0,0);}
  const search=page.locator('[data-mail-search-input]');await search.fill('Unterlagen');await page.waitForTimeout(400);await shot('search');if(width<768){const inputBox=await search.boundingBox();assert(inputBox.width>=width-164,'active phone search has room for text');await page.locator('[data-search-back]').click();assert.equal(await search.inputValue(),'Unterlagen','closing expanded search keeps the query');assert(await page.locator('#mail-quick-settings-toggle').isVisible());}await search.fill('');await search.blur();
  await page.locator('#mail-quick-settings-toggle').click();const panel=page.locator('[data-mail-quick-settings]');await panel.waitFor();await page.waitForTimeout(400);await shot('settings');
  await panel.getByRole('radio',{name:/^Kompakt/}).check();await page.waitForTimeout(350);await shot('compact-settings');
  if(width>=1024){const subject=row.locator('.mail-desktop-subject'),summary=row.locator('.mail-desktop-summary'),chips=row.locator('[data-message-labels]');const sb=await subject.boundingBox(),cb=await chips.boundingBox(),mb=await summary.boundingBox();assert(sb.width>=110,'long subject retains useful width '+sb.width);assert(cb.x+cb.width<=mb.x+mb.width+1,'labels fit the row');const noOverlap=sb.x+sb.width<=cb.x+1||cb.x+cb.width<=sb.x+1;assert(noOverlap,'subject and labels never overlap');}
  const heading=await panel.locator('[data-mail-quick-settings-header]').boundingBox(),close=await panel.getByRole('button',{name:'Schließen',exact:true}).boundingBox();assert(close.y>=heading.y&&close.y+close.height<=heading.y+heading.height+1);
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});await page.waitForTimeout(300);
  const nav=page.locator('[data-inbox-categories]'),strip=nav.locator('.mail-category-strip');
  const next=nav.getByRole('button',{name:'Weitere Kategorien',exact:true});
  if(await next.isVisible()){await next.click();await page.waitForTimeout(450);assert(await strip.evaluate(el=>el.scrollLeft>0),'category arrows scroll the strip');}
  await nav.getByRole('link',{name:'Bestellung',exact:true}).click();await page.waitForURL('**/orders');await page.waitForTimeout(350);const active=nav.locator('[aria-current="page"]');const a=await active.boundingBox(),n=await strip.boundingBox();assert(a.x>=n.x-1&&a.x+a.width<=n.x+n.width+1,'active category is fully visible');await shot('category');await page.goBack();await page.waitForURL('**/inbox');await row.waitFor();
  const toolbar=await page.locator('.mail-mobile-list-toolbar').boundingBox(),tabs=await nav.boundingBox();assert(toolbar.y+toolbar.height<=tabs.y+1,'pagination never overlaps categories');
  await row.locator('a').click();await page.waitForTimeout(700);await page.getByText('vielen Dank für das freundliche Gespräch.',{exact:false}).waitFor();await shot('reader');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow '+width);
  console.log(JSON.stringify({width,dark,errors}));assert.deepEqual(errors,[]);await page.close();
 }
}finally{await browser?.close();preview?.kill('SIGTERM');writeFileSync(join(out,'preview.log'),serverLog);rmSync(temporary,{recursive:true,force:true});}
