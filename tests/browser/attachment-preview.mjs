// Actual production router, PDF renderer, worker and fonts; synthetic private mail/PDF APIs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
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
const message={id:'receipt',mailboxId:'box',direction:'inbound',status:'received',category:'primary',read:true,starred:false,fromAddr:'sender@example.test',toAddr:'owner@example.test',subject:'Receipt for the trip',snippet:'Your receipt is attached.',labels:[],hasAttachments:true,createdAt:'2026-10-15T12:00:00Z'};
const attachment={id:'pdf-file',messageId:'receipt',filename,type:'application/pdf',size:pdf.length,disposition:'attachment'};
function json(path){
 if(path==='/api/auth/me')return {user:{id:'owner',name:'Test User',email:'owner@example.test',role:'user',hasAvatar:false},hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages')return {messages:[message],total:1,limit:25,offset:0};
 if(path==='/api/messages/receipt')return {message,body:{textBody:'Your complete receipt is attached.',htmlBody:null},attachments:[attachment]};
 if(path==='/api/agent/availability')return {enabled:false};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 return {folders:[],messages:[],jobs:[],job:null,hiddenLabelIds:[],ok:true};
}
let preview,browser,serverLog='';
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',data=>serverLog+=data.toString());
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/inbox',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const viewport of [{width:320,height:700},{width:390,height:844},{width:844,height:390},{width:1440,height:900}]){
  const page=await browser.newPage({viewport,hasTouch:viewport.width<1024}),errors=[],requests=[];let detailCalls=0,preload=false,pdfFailure=false;
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
  await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());if(request.headers()['x-mailflare-preload']==='1')preload=true;
   if(url.pathname==='/api/messages/receipt'&&++detailCalls===1)return route.fulfill({status:500,body:''});
   if(url.pathname.endsWith('/attachments/pdf-file'))return route.fulfill({status:pdfFailure?503:200,contentType:'application/pdf',body:pdfFailure?'':pdf});
   return route.fulfill({contentType:'application/json',body:JSON.stringify(json(url.pathname))});
  });
  await page.goto(origin+'/inbox');await page.locator('[data-message-row="receipt"]').waitFor();
  for(let i=0;i<100&&!preload;i++)await pause(50);assert(preload,'test runs after background folder preloading begins');
  await page.locator('[data-message-row="receipt"] a[href="/inbox/receipt"]').click();await page.getByText('Your complete receipt is attached.',{exact:true}).waitFor();assert.equal(detailCalls,2,'an empty HTTP 500 recovers without a retry click');
  assert(!requests.some(url=>/pdf\.worker|\/pdf-[\w-]+\.js|\/pdfjs-/.test(url)),'PDF engine and resources stay deferred');
  await page.getByRole('button').filter({hasText:filename}).click();const dialog=page.locator('[data-attachment-viewer]');await dialog.waitFor();
  const first=page.locator('[data-pdf-page="1"][data-pdf-rendered="true"]');await first.waitFor({timeout:20000});
  const bounds=await dialog.boundingBox();assert(bounds);if(viewport.width<1024){assert(Math.abs(bounds.x)<1&&Math.abs(bounds.y)<1);assert(Math.abs(bounds.width-viewport.width)<1&&Math.abs(bounds.height-viewport.height)<1,'mobile preview fills the viewport');}
  assert.equal(await dialog.locator('iframe').count(),0,'iOS native embedded PDF clipping is avoided');
  assert.equal(await dialog.locator('[data-pdf-page]').count(),3,'every page is represented, including rotated and landscape pages');
  for(const number of [1,2,3]){const pageElement=dialog.locator(`[data-pdf-page="${number}"]`);await pageElement.scrollIntoViewIfNeeded();await dialog.locator(`[data-pdf-page="${number}"][data-pdf-rendered="true"]`).waitFor();const pageBox=await pageElement.boundingBox(),scrollBox=await dialog.locator('[data-pdf-scroll]').boundingBox();assert(pageBox.width<=scrollBox.width&&pageBox.x>=scrollBox.x&&pageBox.x+pageBox.width<=scrollBox.x+scrollBox.width+1,'entire page width fits');}
  // Off-screen pages intentionally release their canvas; scroll the placeholder first.
  await dialog.locator('[data-pdf-page="1"]').scrollIntoViewIfNeeded();await first.waitFor();
  const pixels=await first.locator('canvas').evaluate(canvas=>{const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;return {left:[...c.getImageData(2,Math.floor(h/2),1,1).data],right:[...c.getImageData(w-3,Math.floor(h/2),1,1).data],bottom:[...c.getImageData(Math.floor(w/2),h-3,1,1).data]};});
  assert(pixels.left[0]>220&&pixels.left[2]<30&&pixels.right[2]>220&&pixels.right[0]<30&&pixels.bottom[1]>220,'left, right and bottom PDF edges are actually rendered');
  await dialog.getByRole('button',{name:'Zoom in',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-pdf-scroll]').scrollWidth>document.querySelector('[data-pdf-scroll]').clientWidth);await dialog.getByRole('button',{name:'Fit to width',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-pdf-scroll]').scrollWidth<=document.querySelector('[data-pdf-scroll]').clientWidth+1);
  const download=dialog.getByRole('link',{name:'Download',exact:true});assert.equal(await download.getAttribute('download'),filename);assert(await download.isVisible());assert(await dialog.getByRole('button',{name:'Close',exact:true}).isVisible());
  if(viewport.width===390){await page.setViewportSize({width:844,height:390});await page.waitForFunction(()=>Math.abs(document.querySelector('[data-attachment-viewer]').getBoundingClientRect().height-innerHeight)<1);await page.screenshot({path:'/tmp/mailflare-pdf-mobile-landscape.png'});await page.setViewportSize(viewport);}
  await page.screenshot({path:`/tmp/mailflare-pdf-${viewport.width}.png`});await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});
  if(viewport.width===390){pdfFailure=true;await page.getByRole('button').filter({hasText:filename}).click();await dialog.getByRole('alert').waitFor();assert(await dialog.getByRole('link',{name:'Download',exact:true}).isVisible());pdfFailure=false;await dialog.getByRole('button',{name:'Try again',exact:true}).click();await first.waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});}
  assert.deepEqual(errors,[]);assert(!requests.some(url=>!url.startsWith(origin)),'PDFs and rendering resources stay on the application origin');console.log(JSON.stringify({viewport,transientReaderFailureRecovered:true,fullscreen:viewport.width<1024,allPages:true,bothEdgesRendered:true,zoom:true,download:true}));await page.close();
 }
}finally{await browser?.close();if(preview){preview.kill('SIGTERM');await new Promise(resolve=>{if(preview.exitCode!==null)return resolve();preview.once('exit',resolve);setTimeout(()=>{preview.kill('SIGKILL');resolve();},5000).unref();});}writeFileSync('/tmp/mailflare-pdf-browser-preview.log',serverLog);rmSync(temporary,{recursive:true,force:true});}
