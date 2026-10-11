// Actual preference control and sanitized renderer, including delayed and failed requests.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {build} from 'esbuild';
const browserName=process.env.MAILFLARE_BROWSER||'chromium';
assert(['chromium','firefox','webkit'].includes(browserName));
const browserType=(await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright'))[browserName];
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-external-browser-'));
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
writeFileSync(join(dir,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LanguageProvider} from '@/components/language-provider';import {EmailHtmlRenderer} from '@/components/messages/email-html-renderer';import {ExternalContentSettings} from '@/components/settings/external-content-settings';import {setClientSessionToken} from '@/lib/auth/client';import de from '../../public/locales/de.json';window.__switchAccount=setClientSessionToken;
const html='<p>Nachricht</p><img id="remote" src="https://remote.example/image.png"><script>window.__unsafe=true</script><form><input></form><iframe src="https://remote.example/frame"></iframe>';
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}><main className="p-4"><ExternalContentSettings/><section data-mail="a"><EmailHtmlRenderer html={html}/></section><section data-mail="b"><EmailHtmlRenderer html={html}/></section></main></LanguageProvider></QueryClientProvider>);`);
let browser,server;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:join(root,'tsconfig.json'),alias:{'@':join(root,'src')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(name=>name.startsWith('index.')&&name.endsWith('.css'))));
 const assets={'/':Buffer.from('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'),'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(assets[path]?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(assets[path]||'Not found');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserType.launch({headless:true,...(browserName==='chromium'&&process.env.MAILFLARE_CHROMIUM_EXECUTABLE?{executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE}:{}),...(browserName==='chromium'?{args:['--no-sandbox']}:{})});
 for(const viewport of [{width:390,height:844},{width:820,height:1180},{width:1440,height:900}]){
  const page=await browser.newPage({viewport,hasTouch:viewport.width<1024}),errors=[],remote=[];
  page.on('pageerror',error=>errors.push(error.message));
  let enabled=true,failGet=false,failPatch=false,release,hold=true,reads=0,account='owner';
  await page.route('https://remote.example/**',route=>{remote.push(route.request().url());return route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==','base64')});});
  await page.route('**/api/auth/me',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({user:{id:account}})}));
  await page.route('**/api/settings/external-content',async route=>{
   if(route.request().method()==='PATCH'){
    if(failPatch)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"offline"}'});
    enabled=route.request().postDataJSON().enabled;
   }else{reads++;if(hold)await new Promise(resolve=>release=resolve);}
   return route.fulfill({status:failGet?503:200,contentType:'application/json',body:JSON.stringify(failGet?{error:'offline'}:{enabled:account==='other'?false:enabled})});
  });
  await page.goto(origin);const control=page.getByRole('switch',{name:de['settings.externalContent.title'],exact:true}),first=page.locator('[data-mail=a]'),second=page.locator('[data-mail=b]');await first.locator('#remote').waitFor({state:'attached'});
  await page.waitForFunction(()=>document.querySelector('button[role=switch]')?.disabled);assert.equal(remote.length,0,'no remote requests before saved settings load');
  for(let i=0;i<200&&!release;i++)await page.waitForTimeout(10);assert(release,'preference request reached the server');hold=false;release();await first.getByRole('button',{name:de['message.blockRemote'],exact:true}).waitFor();assert.equal(reads,1,'all renderers and settings share one preference request');assert.equal(await first.locator('#remote').getAttribute('src'),'https://remote.example/image.png');
  assert.equal(await first.locator('script,iframe,form,input').count(),0);assert.equal(await page.evaluate(()=>window.__unsafe),undefined);
  const set=async value=>{if((await control.getAttribute('aria-checked'))!==String(value))await control.click();await page.waitForFunction(value=>document.querySelector('button[role=switch]')?.getAttribute('aria-checked')===String(value)&&!document.querySelector('button[role=switch]').disabled,value);};
  await set(false);for(const mail of [first,second])assert.equal(await mail.locator('#remote').getAttribute('src'),null);
  await first.getByRole('button',{name:de['message.allowRemote'],exact:true}).click();assert.equal(await first.locator('#remote').getAttribute('src'),'https://remote.example/image.png');assert.equal(await second.locator('#remote').getAttribute('src'),null,'one-message override does not authorize other messages');
  await set(true);await first.getByRole('button',{name:de['message.blockRemote'],exact:true}).click();assert.equal(await first.locator('#remote').getAttribute('src'),null);await set(false);await set(true);assert.equal(await first.locator('#remote').getAttribute('src'),'https://remote.example/image.png','changing the general policy resets old message overrides');
  failPatch=true;await control.click();await page.getByRole('alert').waitFor();assert.equal(await first.locator('#remote').getAttribute('src'),'https://remote.example/image.png','failed saves retain the previous saved preference');failPatch=false;await page.getByRole('button',{name:de['labels.visibility.retry'],exact:true}).click();await control.waitFor();await page.waitForFunction(()=>!document.querySelector('button[role=switch]').disabled);await set(false);
  await page.reload();await first.getByRole('button',{name:de['message.allowRemote'],exact:true}).waitFor();assert.equal(await first.locator('#remote').getAttribute('src'),null,'blocking survives reload');
  failGet=true;remote.length=0;await page.reload();await page.getByRole('alert').waitFor();assert.equal(remote.length,0,'failed preferences never fall back to allowed');failGet=false;await page.getByRole('button',{name:de['labels.visibility.retry'],exact:true}).click();await page.waitForFunction(()=>!document.querySelector('button[role=switch]').disabled);await set(true);
  account='other';await page.evaluate(()=>window.__switchAccount('other-session'));await page.waitForFunction(()=>document.querySelector('button[role=switch]')?.getAttribute('aria-checked')==='false'&&!document.querySelector('button[role=switch]').disabled);assert.equal(await first.locator('#remote').getAttribute('src'),null,'switching accounts uses the new account preference');
  assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));console.log(JSON.stringify({viewport,defaultAllowed:true,pendingAndFailureBlocked:true,accountScoped:true,sharedPreference:true,messageOverride:true,saveRetry:true,reloadPersists:true,activeContentRemoved:true}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
