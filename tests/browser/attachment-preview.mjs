// Actual production router, PDF renderer, worker and fonts; synthetic private mail/PDF APIs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const locale=process.env.MAILFLARE_PDF_LOCALE||'en',dark=process.env.MAILFLARE_PDF_DARK==='1';
const translations=JSON.parse(readFileSync(locale==='de'?'public/locales/de.json':'src/lib/i18n/en.json','utf8'));
const t=key=>translations[key];
const passwordLabels=locale==='de'?{title:'Passwortgeschütztes PDF',input:'PDF-Passwort',open:'PDF öffnen',cancel:'Abbrechen',incorrect:'Das Passwort ist nicht korrekt. Bitte versuche es erneut.'}:{title:'Password-protected PDF',input:'PDF password',open:'Open PDF',cancel:'Cancel',incorrect:'Incorrect password. Please try again.'};
const encryptedPdfs=[
 {id:'pdf-encrypted-128',filename:'Encrypted-statement-AES128.pdf',password:'fixture-pass-128',bytes:readFileSync(new URL('../fixtures/pdf-password/aes128.pdf',import.meta.url))},
 {id:'pdf-encrypted-256',filename:'Encrypted-statement-AES256.pdf',password:' fixture-pass-256 ',bytes:readFileSync(new URL('../fixtures/pdf-password/aes256.pdf',import.meta.url))},
];
const temporary=mkdtempSync(join(tmpdir(),'mailflare-pdf-browser-'));
const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const origin=`http://127.0.0.1:${port}`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function pdfFixture(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
 for(const [index,[width,height,rotation]] of [[600,840,0],[840,600,0],[600,840,90]].entries()){
  const drawing=`1 0 0 rg 0 0 12 ${height} re f\n0 0 1 rg ${width-12} 0 12 ${height} re f\n0 1 0 rg 0 0 ${width} 12 re f\n0 0 0 rg BT /F1 20 Tf 40 ${height-60} Td (Receipt page ${index+1}) Tj ET\n`;
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotation} /Resources << /Font << /F1 9 0 R >> >> /Contents ${4+index*2} 0 R >>`,`<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`);
 }
 objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 let data='%PDF-1.7\n',offsets=[0];for(const [index,object]of objects.entries()){offsets.push(Buffer.byteLength(data));data+=`${index+1} 0 obj\n${object}\nendobj\n`;}
 const xref=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(data);
}
const pdf=pdfFixture(),filename='Receipt-with-a-long-filename-2026.pdf';
const message={id:'receipt',mailboxId:'box',direction:'inbound',status:'received',category:'primary',read:true,starred:false,fromAddr:'sender@example.test',replyTo:'Support <reply@example.test>',toAddr:'owner@example.test',subject:'Receipt for the trip',snippet:'Your receipt is attached.',labels:[],hasAttachments:true,createdAt:'2026-10-15T12:00:00Z'};
const attachment={id:'pdf-file',messageId:'receipt',filename,type:'application/pdf',size:pdf.length,disposition:'attachment'};
const images=['png','jpeg','gif','webp'].map(ext=>({id:'image-'+ext,messageId:'receipt',filename:'Photo.'+ext.toUpperCase(),type:'application/octet-stream',size:100,disposition:'attachment'}));
const brokenImage={...images[0],id:'broken-image',filename:'Retry-image.png'};
const walletAttachment={id:'wallet-file',messageId:'receipt',filename:'Flight.pkpass',type:'application/octet-stream',size:4,disposition:'attachment'};
function json(path){
 if(path==='/api/auth/me')return {user:{id:'owner',name:'Test User',email:'owner@example.test',role:'user',hasAvatar:false},hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages')return {messages:[message],total:1,limit:25,offset:0};
 if(path==='/api/messages/receipt')return {message,body:{textBody:'Your complete receipt is attached.',htmlBody:null},attachments:[attachment,...encryptedPdfs.map(file=>({id:file.id,messageId:'receipt',filename:file.filename,type:'application/pdf',size:file.bytes.length,disposition:'attachment'})),walletAttachment,...images,brokenImage]};
 if(path==='/api/agent/availability')return {enabled:false};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 return {folders:[],messages:[],jobs:[],job:null,hiddenLabelIds:[],ok:true};
}
let preview,browser,serverLog='';
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const viewport of [{width:320,height:700},{width:390,height:844},{width:744,height:1133},{width:844,height:390},{width:1440,height:900}].filter(v=>!process.env.VIEWPORT_WIDTH||v.width===Number(process.env.VIEWPORT_WIDTH))){
  const page=await browser.newPage({viewport,hasTouch:viewport.width<1024}),errors=[],requests=[],requestPayloads=[],encryptedDownloads=new Map();let detailCalls=0,preload=false,pdfFailure=false,walletOpens=0,imageFailure=false;
  await page.context().addCookies([{name:'mailflare-locale',value:locale,url:origin},...(dark?[{name:'mailflare-theme-color',value:'dark',url:origin}]:[])]);
  if(dark)await page.addInitScript(()=>localStorage.setItem('mailflare-theme','dark'));
  const emulatePre145Map=viewport.width===320;
  const pdfResponses=[],failedRequests=[],consoleErrors=[];let compatibilityWorkers=0;
  const relevantPdfPath=value=>{const url=new URL(value);return /pdf[.-]|\/pdfjs-|\/attachments\/pdf-file/.test(url.pathname)?url.pathname:null;};
  page.on('response',response=>{const path=relevantPdfPath(response.url());if(path)pdfResponses.push({path,status:response.status(),type:response.headers()['content-type']});});
  page.on('requestfailed',request=>{const path=relevantPdfPath(request.url());if(path)failedRequests.push({path,error:request.failure()?.errorText});});
  page.on('console',message=>{if(message.type()==='error'||message.type()==='warning')consoleErrors.push(message.text().slice(0,500));});
  if(emulatePre145Map){
   // PDF.js's current standard build requires these APIs; the compatibility
   // build must work without them in both the UI realm and its separate worker.
   await page.addInitScript(()=>{for(const prototype of [Map.prototype,WeakMap.prototype]){delete prototype.getOrInsert;delete prototype.getOrInsertComputed;}});
   await page.route(/\/pdf\.worker[^/]*\.mjs(?:\?.*)?$/,async route=>{
    const response=await route.fetch();assert(response.ok());compatibilityWorkers++;
    await route.fulfill({response,body:'for (const p of [Map.prototype, WeakMap.prototype]) { delete p.getOrInsert; delete p.getOrInsertComputed; }\n'+await response.text()});
   });
  }
  attachment.type=viewport.width===320?'application/octet-stream':viewport.width===390?'Application/PDF; name="receipt.pdf"':viewport.width===844?'application/x-pdf':'application/pdf';
  const imageBytes=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=100;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle='blue';ctx.fillRect(0,0,100,80);return Object.fromEntries(['png','jpeg','webp'].map(ext=>[ext,canvas.toDataURL('image/'+ext).split(',')[1]]));});
  imageBytes.gif='R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{requests.push(request.url());requestPayloads.push(request.url()+' '+JSON.stringify(request.headers())+' '+(request.postData()||''));});
  // Context routing also covers a popup's initial navigation request.
  await page.context().route('**/api/messages/receipt/attachments/wallet-file*',async route=>{walletOpens++;assert.equal(new URL(route.request().url()).search,'?open=1');return route.fulfill({contentType:'text/html',body:'<p>Native Wallet handoff boundary</p>'});});
  await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());if(request.headers()['x-mailflare-preload']==='1')preload=true;
   if(url.pathname==='/api/drafts'&&request.method()==='POST')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic stop after checking reply recipient'})});
   if(url.pathname==='/api/messages/receipt'&&++detailCalls===1)return route.fulfill({status:500,body:''});
   if(url.pathname.endsWith('/attachments/broken-image'))return route.fulfill({status:imageFailure?200:503,contentType:'image/png',body:imageFailure?Buffer.from(imageBytes.png,'base64'):''});
   if(url.pathname.includes('/attachments/image-')){const ext=url.pathname.split('image-').pop();return route.fulfill({status:imageFailure?503:200,contentType:'image/'+ext,body:imageFailure?'':Buffer.from(imageBytes[ext],'base64')});}
   const encrypted=encryptedPdfs.find(file=>url.pathname.endsWith('/attachments/'+file.id));
   if(encrypted){encryptedDownloads.set(encrypted.id,(encryptedDownloads.get(encrypted.id)||0)+1);return route.fulfill({contentType:'application/pdf',body:encrypted.bytes});}
   if(url.pathname.endsWith('/attachments/pdf-file'))return route.fulfill({status:pdfFailure?503:200,contentType:'application/pdf',body:pdfFailure?'':pdf});
   return route.fulfill({contentType:'application/json',body:JSON.stringify(json(url.pathname))});
  });
  await page.goto(origin+'/inbox');await page.locator('[data-message-row="receipt"]').waitFor();
  if(dark)assert(await page.locator('html').evaluate(element=>element.classList.contains('dark')),'requested dark theme is active');
  for(let i=0;i<100&&!preload;i++)await pause(50);assert(preload,'test runs after background folder preloading begins');
  await page.locator('[data-message-row="receipt"] a[href="/inbox/receipt"]').click();await page.getByText('Your complete receipt is attached.',{exact:true}).waitFor();assert.equal(detailCalls,2,'an empty HTTP 500 recovers without a retry click');
  assert(!requests.some(url=>/pdf\.worker|\/pdf-[\w-]+\.js|\/pdfjs-/.test(url)),'PDF engine and resources stay deferred');
  // Chromium has no Wallet: verify user-activated top-level navigation, while the
  // server tests verify actual pass MIME, cookies, grants and private headers.
  const walletLink=page.getByRole('link').filter({hasText:'Flight.pkpass'});assert.equal(walletOpens,0,'passes are not downloaded speculatively');assert.equal(await walletLink.getAttribute('download'),null);
  const popupPromise=page.waitForEvent('popup');await walletLink.click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(new URL(popup.url()).pathname,'/api/messages/receipt/attachments/wallet-file');assert.equal(new URL(popup.url()).search,'?open=1');assert.equal(new URL(popup.url()).origin,origin);await popup.close();assert.equal(walletOpens,1);assert.equal(await page.locator('[data-attachment-viewer]').count(),0,'Wallet is handed off directly instead of showing an unsupported preview');
  if(emulatePre145Map)assert.deepEqual(await page.evaluate(()=>[typeof Map.prototype.getOrInsertComputed,typeof WeakMap.prototype.getOrInsertComputed]),['undefined','undefined'],'the app must not pre-polyfill the missing APIs before the lazy PDF engine is loaded');
  await page.getByRole('button').filter({hasText:filename}).click();const dialog=page.locator('[data-attachment-viewer]');await dialog.waitFor();
  const first=page.locator('[data-pdf-page="1"][data-pdf-rendered="true"]');
  try { await first.waitFor({timeout:20000}); }
  catch(error){
   const diagnostics={viewport,browserVersion:browser.version(),emulatePre145Map,compatibilityWorkers,
    capabilities:await page.evaluate(()=>({mapUpsert:typeof Map.prototype.getOrInsertComputed,weakMapUpsert:typeof WeakMap.prototype.getOrInsertComputed,promiseWithResolvers:typeof Promise.withResolvers,offscreenCanvas:typeof OffscreenCanvas})),
    viewer:await dialog.evaluate(element=>({alerts:[...element.querySelectorAll('[role="alert"]')].map(el=>el.textContent),status:[...element.querySelectorAll('[role="status"]')].map(el=>el.textContent),pages:[...element.querySelectorAll('[data-pdf-page]')].map(el=>({page:el.dataset.pdfPage,rendered:el.dataset.pdfRendered,busy:el.getAttribute('aria-busy'),width:el.clientWidth,height:el.clientHeight}))})),
    errors:errors.slice(-10),console:consoleErrors.slice(-10),pdfResponses:pdfResponses.slice(-15),failedRequests:failedRequests.slice(-10)};
   mkdirSync('artifacts/quality',{recursive:true});writeFileSync(`artifacts/quality/pdf-failure-${viewport.width}.json`,JSON.stringify(diagnostics,null,2));
   await page.screenshot({path:`/tmp/mailflare-pdf-failure-${viewport.width}.png`});console.error('PDF preview diagnostic: '+JSON.stringify(diagnostics));throw error;
  }
  if(emulatePre145Map)assert(compatibilityWorkers>0,'compatibility regression must also remove upsert APIs from the PDF worker realm');
  const bounds=await dialog.boundingBox();assert(bounds);if(viewport.width<1024){assert(Math.abs(bounds.x)<1&&Math.abs(bounds.y)<1);assert(Math.abs(bounds.width-viewport.width)<1&&Math.abs(bounds.height-viewport.height)<1,'mobile preview fills the viewport');}
  assert.equal(await dialog.locator('iframe').count(),0,'iOS native embedded PDF clipping is avoided');
  assert.equal(await dialog.locator('[data-pdf-page]').count(),3,'every page is represented, including rotated and landscape pages');
  for(const number of [1,2,3]){const pageElement=dialog.locator(`[data-pdf-page="${number}"]`);await pageElement.scrollIntoViewIfNeeded();await dialog.locator(`[data-pdf-page="${number}"][data-pdf-rendered="true"]`).waitFor();const pageBox=await pageElement.boundingBox(),scrollBox=await dialog.locator('[data-pdf-scroll]').boundingBox();assert(pageBox.width<=scrollBox.width&&pageBox.x>=scrollBox.x&&pageBox.x+pageBox.width<=scrollBox.x+scrollBox.width+1,'entire page width fits');}
  // Off-screen pages intentionally release their canvas; scroll the placeholder first.
  await dialog.locator('[data-pdf-page="1"]').scrollIntoViewIfNeeded();await first.waitFor();
  const pixels=await first.locator('canvas').evaluate(canvas=>{const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;return {left:[...c.getImageData(2,Math.floor(h/2),1,1).data],right:[...c.getImageData(w-3,Math.floor(h/2),1,1).data],bottom:[...c.getImageData(Math.floor(w/2),h-3,1,1).data]};});
  assert(pixels.left[0]>220&&pixels.left[2]<30&&pixels.right[2]>220&&pixels.right[0]<30&&pixels.bottom[1]>220,'left, right and bottom PDF edges are actually rendered');
  await dialog.getByRole('button',{name:t('attachment.zoomIn'),exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-pdf-scroll]').scrollWidth>document.querySelector('[data-pdf-scroll]').clientWidth);await dialog.getByRole('button',{name:t('attachment.fitWidth'),exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-pdf-scroll]').scrollWidth<=document.querySelector('[data-pdf-scroll]').clientWidth+1);
  const download=dialog.getByRole('link',{name:t('attachment.download'),exact:true});assert.equal(await download.getAttribute('download'),filename);assert(await download.isVisible());assert(await dialog.getByRole('button',{name:t('navigation.close'),exact:true}).isVisible());
  if(viewport.width===390){await page.setViewportSize({width:844,height:390});await page.waitForFunction(()=>Math.abs(document.querySelector('[data-attachment-viewer]').getBoundingClientRect().height-innerHeight)<1);await page.screenshot({path:'/tmp/mailflare-pdf-mobile-landscape.png'});await page.setViewportSize(viewport);}
  await page.screenshot({path:`/tmp/mailflare-pdf-${viewport.width}.png`});await dialog.getByRole('button',{name:t('navigation.close'),exact:true}).click();await dialog.waitFor({state:'hidden'});
  if(viewport.width===390){pdfFailure=true;await page.getByRole('button').filter({hasText:filename}).click();await dialog.getByRole('alert').waitFor();assert(await dialog.getByRole('link',{name:t('attachment.download'),exact:true}).isVisible());pdfFailure=false;await dialog.getByRole('button',{name:t('message.retry'),exact:true}).click();await first.waitFor();await dialog.getByRole('button',{name:t('navigation.close'),exact:true}).click();await dialog.waitFor({state:'hidden'});}
  // Real encrypted bytes exercise PDF.js's password callback, including retries
  // in the same worker/document task. Passwords here are public synthetic data.
  const prompt=dialog.locator('[data-pdf-password]');
  const password=dialog.getByLabel(passwordLabels.input,{exact:true});
  const closeViewer=async()=>{await dialog.getByRole('button',{name:t('navigation.close'),exact:true}).click();await dialog.waitFor({state:'hidden'});};
  const openEncrypted=async file=>{
   await page.getByRole('button').filter({hasText:file.filename}).click();await prompt.waitFor();
   await dialog.getByRole('heading',{name:passwordLabels.title,exact:true}).waitFor();
   assert.equal(await dialog.locator('[data-pdf-page]').count(),0,'protected pages are not shown before unlocking');
   assert.equal(await password.getAttribute('type'),'password','password stays concealed initially');
   assert.equal(await password.inputValue(),'','another open never reuses a password');
   const fieldBox=await password.boundingBox(),panelBox=await dialog.boundingBox();
   assert(fieldBox.width>120&&fieldBox.x>=panelBox.x&&fieldBox.x+fieldBox.width<=panelBox.x+panelBox.width+1,'password field fits the viewport');
  };
  for(const [index,file] of encryptedPdfs.entries()){
   await openEncrypted(file);const downloads=encryptedDownloads.get(file.id);
   await dialog.getByRole('button',{name:passwordLabels.open,exact:true}).click();
   assert(await password.evaluate(input=>input.validity.valueMissing),'empty input cannot submit the password form');
   assert.equal(encryptedDownloads.get(file.id),downloads);
   // Enter submits the form and a rejected password can be replaced immediately.
   const wrong=index===0?'synthetic-wrong-password':encryptedPdfs[0].password;
   await password.fill(wrong);await dialog.getByRole('button',{name:t('attachment.pdfShowPassword'),exact:true}).click();
   assert.equal(await password.getAttribute('type'),'text');assert.equal(await password.inputValue(),wrong);
   await password.press('Enter');
   await dialog.getByRole('alert').filter({hasText:passwordLabels.incorrect}).waitFor();
   assert.equal(await password.inputValue(),'','a rejected password is discarded');assert.equal(await password.getAttribute('type'),'password','retry conceals input again');
   assert.equal(encryptedDownloads.get(file.id),downloads,'wrong password does not redownload the attachment');
   if(index===0){
    await password.fill('second-wrong-password');await password.press('Enter');
    await dialog.getByRole('alert').filter({hasText:passwordLabels.incorrect}).waitFor();
    assert.equal(await password.inputValue(),'');assert.equal(encryptedDownloads.get(file.id),downloads);
   }
   if(index===0)await page.screenshot({path:`/tmp/mailflare-pdf-password-${locale}-${viewport.width}.png`});
   await password.fill(file.password);await dialog.getByRole('button',{name:passwordLabels.open,exact:true}).click();
   await first.waitFor();await prompt.waitFor({state:'hidden'});
   assert.equal(await dialog.locator('[data-pdf-page]').count(),2,'both encrypted pages become available');
   const second=dialog.locator('[data-pdf-page="2"]');await second.scrollIntoViewIfNeeded();await dialog.locator('[data-pdf-page="2"][data-pdf-rendered="true"]').waitFor();
   assert.equal(encryptedDownloads.get(file.id),downloads,'correct password reuses the same downloaded bytes after rejection');
   await dialog.getByRole('button',{name:t('attachment.zoomIn'),exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[data-pdf-scroll]').scrollWidth>document.querySelector('[data-pdf-scroll]').clientWidth);
   await dialog.getByRole('button',{name:t('attachment.fitWidth'),exact:true}).click();
   await closeViewer();
  }
  // A completed unlock, an abandoned typed password and a different attachment
  // all begin with independent document tasks. Cancellation keeps the mail open.
  await openEncrypted(encryptedPdfs[0]);await password.fill(encryptedPdfs[0].password);
  await dialog.getByRole('button',{name:passwordLabels.cancel,exact:true}).click();await dialog.waitFor({state:'hidden'});
  await openEncrypted(encryptedPdfs[0]);assert.equal(await password.inputValue(),'');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await openEncrypted(encryptedPdfs[1]);await password.fill(encryptedPdfs[1].password);
  // Submit and cancel within one browser task, before the worker can respond.
  await prompt.evaluate((form,cancelLabel)=>{form.requestSubmit();[...form.querySelectorAll('button')].find(button=>button.textContent===cancelLabel).click();},passwordLabels.cancel);
  await dialog.waitFor({state:'hidden'});await openEncrypted(encryptedPdfs[1]);
  assert.equal(await password.inputValue(),'','a cancelled in-flight unlock cannot restore its password or document');await closeViewer();
  await page.getByRole('button').filter({hasText:filename}).click();await first.waitFor();
  assert.equal(await dialog.locator('[data-pdf-page]').count(),3,'plain PDF still opens after cancelling an encrypted one');
  assert.equal(await prompt.count(),0);await closeViewer();
  const persisted=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie}));
  for(const value of [...encryptedPdfs.map(file=>file.password),'synthetic-wrong-password','second-wrong-password']){
   assert(!persisted.includes(value),'attachment passwords are not persisted in browser storage');
   assert(!requestPayloads.some(payload=>payload.includes(value)||payload.includes(encodeURIComponent(value))),'attachment passwords never leave the browser in requests');
  }
  for(const file of images){
   await page.getByRole('button').filter({hasText:file.filename}).click();await dialog.waitFor();
   const image=dialog.getByRole('img',{name:file.filename,exact:true});await image.waitFor();await page.waitForFunction(()=>{const img=document.querySelector('[data-attachment-viewer] img');return img?.complete&&img.naturalWidth>0;});
   const box=await image.boundingBox(),container=await dialog.boundingBox();assert(box.width<=container.width&&box.height<=container.height,'image fits viewport');
   await dialog.getByRole('button',{name:t('navigation.close'),exact:true}).click();await dialog.waitFor({state:'hidden'});
  }
  if(viewport.width===390){await page.getByRole('button').filter({hasText:brokenImage.filename}).click();await dialog.getByRole('button',{name:t('message.retry'),exact:true}).waitFor();assert.equal(await dialog.getByRole('link',{name:t('attachment.download'),exact:true}).count(),2);imageFailure=true;await dialog.getByRole('button',{name:t('message.retry'),exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-attachment-viewer] img')?.naturalWidth>0);await dialog.getByRole('button',{name:t('navigation.close'),exact:true}).click();await dialog.waitFor({state:'hidden'});}
  try {
   const [replyRequest]=await Promise.all([
    page.waitForRequest(r=>new URL(r.url()).pathname==='/api/drafts'&&r.method()==='POST',{timeout:10000}),
    page.getByRole('button',{name:locale==='de'?/^Antworten(?: \(r\))?$/:/^Reply(?: \(r\))?$/}).first().click({timeout:10000}),
   ]);
   assert.equal(replyRequest.postDataJSON().to,'Support <reply@example.test>','reader Reply uses Reply-To rather than From');
  } catch(error) {
   await page.screenshot({path:`/tmp/upstream-reply-${viewport.width}-failure.png`});
   console.error(JSON.stringify({viewport,buttons:await page.getByRole('button',{name:locale==='de'?/^Antworten(?: \(r\))?$/:/^Reply(?: \(r\))?$/}).evaluateAll(buttons=>buttons.map(b=>({html:b.outerHTML,rect:b.getBoundingClientRect().toJSON()}))),errors}));throw error;
  }
  assert.deepEqual(errors,[]);assert(!requests.some(url=>!url.startsWith(origin)),'PDFs and rendering resources stay on the application origin');console.log(JSON.stringify({viewport,locale,dark,encryptedPdfPassword:true,wrongPasswordRetry:true,localPasswordOnly:true,cancelAndReopen:true,aes128:true,aes256:true,transientReaderFailureRecovered:true,replyToRecipient:true,fullscreen:viewport.width<1024,allPages:true,bothEdgesRendered:true,zoom:true,download:true,walletHandoff:true,pdfMime:attachment.type,pre145MapCompatibility:emulatePre145Map,images:true,imageRetry:viewport.width===390}));await page.close();
 }
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-pdf-browser-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
