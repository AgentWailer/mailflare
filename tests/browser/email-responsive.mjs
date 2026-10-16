// Actual sanitized HTML renderer; synthetic newsletters, no live mailbox or external image requests.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-email-responsive-'));
const mails={
 fixed:'<html><head><style>.newsletter{width:680px!important;min-width:680px!important;border-spacing:0;background:#e1fff3}td{padding:24px} .hero{width:632px;height:430px;background:#84b5a5} .footer{padding:24px}</style></head><body><table id="newsletter" class="newsletter" width="680"><tr><td><h1>EF ENGLISH LIVE</h1><p>Wie zufrieden bist du mit unserem Support?</p><div id="hero" class="hero">Nachrichteninhalt</div><p><a id="mail-link" href="https://example.test/survey">Feedback geben</a></p></td></tr></table><div id="end">Ende der E-Mail</div></body></html>',
 fluid:'<div id="fluid" style="width:100%;font-size:16px"><h2>Persönliche Nachricht</h2><p>Eine normale Nachricht bleibt in Originalgröße gut lesbar und passt sich dem Lesebereich an.</p><a id="mail-link" href="https://example.test/reply">Antwort</a><p>https://example.test/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</p><p id="end">Ende der E-Mail</p></div>',
 rtl:'<html dir="rtl"><body><table id="newsletter" dir="rtl" style="width:720px;min-width:720px"><tr><td><h2>رسالة جديدة</h2><div style="width:720px;height:250px;background:#bde">Inhalt</div><a id="mail-link" href="https://example.test/rtl">Link</a><p id="end">Ende der E-Mail</p></td></tr></table></body></html>',
 image:'<div><p>Nachgeladenes Bild</p><img id="photo" src="https://images.example.test/photo.png" alt="Bild"><p><a id="mail-link" href="https://example.test/image">Link unter dem Bild</a></p><p id="end">Ende der E-Mail</p></div>',
 quote:'<p>Aktuelle Nachricht</p><details id="quote"><summary>Vorherige Nachricht</summary><table id="newsletter" style="width:700px"><tr><td><div style="width:700px;height:200px">Vorheriger Newsletter</div><a id="mail-link" href="https://example.test/quote">Link</a><p id="end">Ende der E-Mail</p></td></tr></table></details>',
 hostile:'<style>*{margin:7px!important;max-width:none!important}div{min-width:760px!important}</style><div id="newsletter" style="width:760px"><p>Feste Styles</p><a id="mail-link" href="https://example.test/style">Link</a><p id="end">Ende der E-Mail</p></div>',
};
writeFileSync(join(dir,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LanguageProvider} from '@/components/language-provider';import {EmailHtmlRenderer} from '@/components/messages/email-html-renderer';import {applyTheme} from '@/components/theme-utils';window.__theme=applyTheme;window.__mails=${JSON.stringify(mails)};function App(){const [mail,setMail]=React.useState('fixed');window.__setMail=setMail;return <LanguageProvider initialLocale="en"><main style={{padding:12,maxWidth:900,margin:'auto'}}><section id="reader"><EmailHtmlRenderer html={window.__mails[mail]}/></section><p id="after">Nach dem Inhalt</p></main></LanguageProvider>}createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><App/></QueryClientProvider>);`);
let browser,server;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(n=>n.startsWith('index.')&&n.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://fixture').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of [320,390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:844},hasTouch:width<1024}),errors=[];let imageRoute;
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({user:{id:'owner'},enabled:true})}));await page.route('https://images.example.test/**',route=>{imageRoute=route;});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#hero').waitFor();
  async function fitted(target='#newsletter'){
   await page.waitForFunction(selector=>{const host=document.querySelector('[data-email-reader]'),el=host?.shadowRoot?.querySelector(selector);if(!el)return false;const h=host.getBoundingClientRect(),b=el.getBoundingClientRect(),end=host.shadowRoot.querySelector('#end')?.getBoundingClientRect();return !!h.width&&b.width>0&&b.left>=h.left-1&&b.right<=h.right+1&&end&&end.bottom<=h.bottom+1;},target);
   const host=page.locator('[data-email-reader]'),geometry=await host.evaluate(el=>{const bounds=el.getBoundingClientRect(),end=el.shadowRoot.querySelector('#end').getBoundingClientRect();return {bottom:bounds.bottom,end:end.bottom,after:document.querySelector('#after').getBoundingClientRect().top,scrollWidth:el.scrollWidth,width:el.clientWidth};});
   assert(geometry.end<=geometry.bottom+2,'the bottom of the email is not clipped '+JSON.stringify(geometry));assert(geometry.bottom-geometry.end<60,'scaled content leaves no large blank tail');assert(geometry.after>=geometry.bottom-1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'the app never gains horizontal scrolling');assert(geometry.scrollWidth<=geometry.width+1,'no hidden horizontal scroll surface');
   return Number(await host.getAttribute('data-email-scale'));
  }
  const initialScale=await fitted();assert.equal(initialScale<1,width<768);await page.screenshot({path:`/tmp/mailflare-newsletter-${width}.png`});
  await page.locator('#mail-link').evaluate(el=>el.addEventListener('click',event=>{event.preventDefault();window.__clickedLink=el.href;}));await page.locator('#mail-link').click();assert.equal(await page.evaluate(()=>window.__clickedLink),'https://example.test/survey');
  await page.evaluate(()=>window.__theme('dark'));await fitted();await page.evaluate(()=>window.__theme('light'));await fitted();
  await page.setViewportSize({width:width<768?844:320,height:700});await fitted();await page.setViewportSize({width,height:844});await fitted();
  await page.locator('[data-email-reader]').evaluate(el=>{window.__fitChanges=0;window.__fitObserver=new MutationObserver(()=>window.__fitChanges++);window.__fitObserver.observe(el,{attributes:true,attributeFilter:['data-email-scale']});});await page.waitForTimeout(200);assert((await page.evaluate(()=>window.__fitChanges))<=2,'a resting email does not keep recalculating');await page.evaluate(()=>window.__fitObserver.disconnect());
  await page.locator('#reader').evaluate(el=>el.style.width='280px');assert((await fitted())<1);await page.locator('#reader').evaluate(el=>el.style.width='');await fitted();
  for(const kind of ['fluid','rtl','hostile','quote','image']){
   await page.evaluate(kind=>window.__setMail(kind),kind);
   if(kind==='fluid'){await page.locator('#fluid').waitFor();assert.equal(await fitted('#fluid'),1,'fluid messages retain their original font size');}
   else if(kind==='quote'){await page.locator('#quote summary').click();await fitted();}
   else if(kind==='image'){for(let i=0;i<100&&!imageRoute;i++)await page.waitForTimeout(20);assert(imageRoute,'external-content preference permits the fixture image');await imageRoute.fulfill({contentType:'image/png',body:readFileSync(join(root,'public/icon-512.png'))});await page.waitForFunction(()=>document.querySelector('[data-email-reader]').shadowRoot.querySelector('#photo')?.naturalWidth===512);await fitted('#photo');}
   else await fitted();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,fixedNewsletter:true,originalFluidSize:true,rtl:true,lateImage:true,quoteExpansion:true,parentResize:true,themePreserved:true,linkClickable:true,noHorizontalScroll:true}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
