import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {build} from 'esbuild';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','mailflare-login-browser-'));
const write=(name,content)=>writeFileSync(join(dir,name),content);
write('navigation.ts',`import {useSyncExternalStore} from 'react';const subscribe=fn=>{window.addEventListener('fixture:navigate',fn);return ()=>window.removeEventListener('fixture:navigate',fn)};export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname);const router={replace:href=>{history.replaceState({},'',href);window.dispatchEvent(new Event('fixture:navigate'))},refresh:()=>{}};export const useRouter=()=>router;`);
write('link.tsx',`export default function Link({children,...props}){return <a {...props}>{children}</a>}`);
write('entry.tsx',`import {createRoot} from 'react-dom/client';import {LoginClient} from '../../src/app/(auth)/login/login-client';import {AuthGuard} from '../../src/components/auth/auth-guard';import {LanguageProvider} from '../../src/components/language-provider';import {ForkSource} from '../../src/components/fork-source';import {ProgressiveAvatarImage} from '../../src/components/progressive-avatar-image';import {usePathname} from 'next/navigation';import messages from '../../public/locales/de.json';function App(){const path=usePathname();return <LanguageProvider initialLocale="de" initialMessages={messages}>{path==='/inbox'?<main><h1>Test-Posteingang</h1><ProgressiveAvatarImage priority src="/api/profile/avatar" alt="Profilbild" /></main>:<><AuthGuard mode="public" allowAuthenticated={new URLSearchParams(location.search).get('add')==='1'}><LoginClient adding={new URLSearchParams(location.search).get('add')==='1'}/></AuthGuard><ForkSource/></>}</LanguageProvider>};createRoot(document.getElementById('root')).render(<App/>);`);
const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(name=>(name.startsWith('index.')||name.startsWith('index-'))&&name.endsWith('.css'))));
let server,browser;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'next/link':join(dir,'link.tsx'),'next/navigation':join(dir,'navigation.ts')},define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY':'undefined'},logLevel:'silent'});
 const html='<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
 const assets={'/fixture.js':readFileSync(join(dir,'fixture.js')),'/fixture.css':css,'/icon-96.png':readFileSync(join(root,'public/icon-96.png'))};
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':'text/html'});res.end(assets[path]??html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
 for(const mode of ['ordinary','mfa','saved','add','retry']){
  const page=await browser.newPage({viewport:mode==='ordinary'?{width:1440,height:900}:{width:320,height:700}}),errors=[],avatars=[];page.on('pageerror',error=>errors.push(error.message));let submissions=0,verified=false;
  if(mode==='saved'||mode==='add')await page.addInitScript(()=>localStorage.setItem('mailflare-session-token','fixture-session'));
  await page.route('**/api/**',route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path==='/api/profile/avatar'){avatars.push(path);return route.fulfill({contentType:'image/png',body:assets['/icon-96.png']});}
   if(path==='/api/auth/me')return route.fulfill({status:req.headers().authorization?200:401,contentType:'application/json',body:JSON.stringify(req.headers().authorization?{user:{id:'owner',role:'user'}}:{error:'Unauthorized'})});
   if(path==='/api/auth/login'){submissions++;if(mode==='retry'&&submissions===1)return route.fulfill({status:401,contentType:'application/json',body:'{"error":"Test failure"}'});if(mode==='mfa')return route.fulfill({contentType:'application/json',body:'{"mfaRequired":true,"challengeToken":"fixture-challenge"}'});return route.fulfill({contentType:'application/json',body:'{"ok":true,"token":"fixture-new-session","redirect":"/inbox"}'});}
   if(path==='/api/auth/mfa/verify'){verified=true;return route.fulfill({contentType:'application/json',body:'{"ok":true,"token":"fixture-mfa-session","redirect":"/inbox"}'});}return route.fulfill({contentType:'application/json',body:'{}'});
  });
  await page.goto(origin+(mode==='add'?'/login?add=1':'/'));
  if(mode!=='saved'){
   await page.getByLabel(de['auth.email'],{exact:true}).waitFor();assert.equal(await page.locator('main').count(),1);assert.equal(await page.locator('.fork-source').isVisible(),false);assert.equal(await page.getByText(de['home.headline'],{exact:true}).count(),0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   if(mode==='ordinary')await page.screenshot({path:'/tmp/mailflare-plain-login.png'});
   await page.getByLabel(de['auth.email'],{exact:true}).fill('owner@example.test');await page.getByLabel(de['auth.password'],{exact:true}).fill('fixture-password');await page.getByRole('button',{name:de['auth.signIn'],exact:true}).click();
   if(mode==='retry'){await page.getByText('Test failure',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>location.pathname),'/');await page.getByRole('button',{name:de['auth.signIn'],exact:true}).click();}
   if(mode==='mfa'){await page.getByLabel(de['auth.code'],{exact:true}).fill('123456');await page.getByRole('button',{name:de['auth.verify'],exact:true}).click();assert(verified);}
  }
  await page.getByRole('heading',{name:'Test-Posteingang',exact:true}).waitFor();assert.equal(await page.evaluate(()=>location.pathname),'/inbox');const image=page.getByRole('img',{name:'Profilbild',exact:true});await image.waitFor();await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);assert.equal(await image.getAttribute('loading'),'eager');assert.equal(await image.getAttribute('fetchpriority'),'high');assert.equal(await image.evaluate(el=>getComputedStyle(el).filter),'none');assert.equal(avatars.length,1,'the prioritized photo needs no blurred preview request');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({mode,plainLogin:true,inboxDirect:true,sharpPrioritizedAvatar:true,avatarRequests:avatars.length}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
