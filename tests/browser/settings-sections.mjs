import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dir = mkdtempSync(join(root, 'node_modules', 'settings-sections-browser-'));
const write = (name, body) => writeFileSync(join(dir, name), body);
write('mailbox.ts', `const box={id:'box',localPart:'owner',hostname:'example.test',permission:'full_access'};export const useSelectedMailbox=()=>({selectedMailbox:box,mailboxes:[box],isLoading:false});`);
write('navigation.ts', `export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);export const useRouter=()=>({replace:()=>{},push:path=>{window.lastSettingsNavigation=path},prefetch:()=>{},refresh:()=>{}});`);
write('link.tsx', `export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>;}`);
write('server.ts', `import de from '../../public/locales/de.json';import {createTranslator} from '@/lib/i18n/utils';export const getServerTranslator=async()=>createTranslator('de',de);`);
write('loading.ts', 'export const usePageLoading=()=>({startLoading:()=>{},stopLoading:()=>{}});');
write('entry.tsx', `import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LanguageProvider} from '@/components/language-provider';import Layout from '@/app/(settings)/settings/layout';import Inbox from '@/app/(settings)/settings/inbox/page';import Account from '@/app/(settings)/settings/account/page';import Security from '@/app/(settings)/settings/security/page';import Rules from '@/app/(settings)/settings/rules/page';import Keys from '@/app/(settings)/settings/api-keys/page';import Apps from '@/app/(settings)/settings/app-passwords/page';import Import from '@/app/(settings)/settings/import/page';import Export from '@/app/(settings)/settings/export/page';import de from '../../public/locales/de.json';const pages={inbox:Inbox,security:Security,rules:Rules,'api-keys':Keys,'app-passwords':Apps};const key=location.pathname.split('/').at(-1),content=pages[key]?await pages[key]():key==='account'?<Account/>:key==='import'?<Import/>:<Export/>;createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}><div style={{height:"100dvh",display:"flex",flexDirection:"column"}}><header style={{height:64,flexShrink:0}}/><main style={{minHeight:0,flex:1,overflowY:"auto"}}><Layout>{content}</Layout></main></div></LanguageProvider></QueryClientProvider>);`);
let server, browser;
const user = {id:'user',role:'admin',name:'Steffen',email:'owner@example.test',resetEmail:'recovery@example.test',forwardingEmail:null,canForwardEmail:true,timeZone:'Europe/Berlin',hasAvatar:false};
const responseFor = path => path==='/api/auth/me'?{user}:path==='/api/folders'?{folders:[{id:'paperless',name:'Paperless',color:'#2563eb'}]}:path==='/api/settings/paperless'?{available:true,connection:{id:'connection',baseUrl:'https://dms.example.test',enabled:false,hasToken:true,hasAccessCredentials:true,labelId:'paperless',processedLabelId:null},labels:[{id:'paperless',name:'Paperless',parentId:null}],jobs:[],counts:[]}:path==='/api/import/gmail'?{configured:false,missing:[],connections:[],jobs:[]}:path==='/api/settings/mfa'?{enabled:false,recoveryCodesLeft:0}:path==='/api/api-keys'?{apiKeys:[]}:path.includes('/api/mailboxes/')?{mailbox:{id:'box',signature:'',autoReplyEnabled:false,autoReplySubject:'',autoReplyBody:''}}:{jobs:[],rules:[],hiddenLabelIds:[],messages:[]};
try {
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'@':join(root,'src'),'next/link':join(dir,'link.tsx'),'next/navigation':join(dir,'navigation.ts'),'@/lib/i18n/server':join(dir,'server.ts'),'@/components/mailbox-provider':join(dir,'mailbox.ts'),'@/components/page-loading':join(dir,'loading.ts')},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-context',setup(b){b.onResolve({filter:/(?:^|\/)mailbox-provider$/},()=>({path:join(dir,'mailbox.ts')}));}}],logLevel:'silent'});
 const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(f=>f.startsWith('index.')&&f.endsWith('.css'))));
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(path==='/fixture.js'?readFileSync(join(dir,'fixture.js')):path==='/fixture.css'?css:'<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0;background:#f5f7fc"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of [320,390,1440]) {
  for(const [pageName,expectedCount] of [['account',4],['inbox',11],['security',2],['rules',2],['api-keys',1],['app-passwords',1],['import',3],['export',1]]) {
   const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],requests=[],writes=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/api/**',route=>{const req=route.request(),path=new URL(req.url()).pathname;requests.push(path);if(req.method()!=='GET')writes.push({path,body:req.postDataJSON()});return route.fulfill({contentType:'application/json',body:JSON.stringify(responseFor(path))});});
   await page.goto(`${base}/settings/${pageName}`);
   const cards=page.locator('[data-settings-section]');await cards.first().waitFor();assert.equal(await cards.count(),expectedCount,pageName);
   assert.equal(await cards.locator('h3 > button[aria-expanded="false"]').count(),expectedCount);
   assert.equal(await page.locator('[data-settings-section] input:visible').count(),0);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${pageName} closed overflow at ${width}`);
   if(pageName==='inbox') {
    assert(await page.getByRole('combobox',{name:'Design',exact:true}).isVisible());assert(await page.getByRole('combobox',{name:'Lesebereich',exact:true}).isVisible());
    assert(!requests.includes('/api/settings/paperless'));const header=page.locator('#labels > h3 > button');await header.click();await page.getByRole('switch').first().waitFor();await header.focus();await page.keyboard.press('Space');assert.equal(await header.getAttribute('aria-expanded'),'false');
    await page.locator('#paperless > h3 > button').click();await page.getByRole('textbox',{name:'Paperless-Adresse',exact:true}).waitFor();
    const url=page.getByRole('textbox',{name:'Paperless-Adresse',exact:true});await url.fill('https://dms.changed.test');await page.locator('#paperless > h3 > button').click();await page.locator('#paperless > h3 > button').click();assert.equal(await url.inputValue(),'https://dms.changed.test');
   } else if(pageName==='account') {
    assert(await page.getByRole('combobox',{name:'Sprache',exact:true}).isVisible());assert(await page.getByRole('combobox',{name:'Design',exact:true}).isVisible());
    await page.locator('#profile > h3 > button').click();await page.locator('#name').fill('Changed name');await page.locator('#profile > h3 > button').click();await page.locator('#profile > h3 > button').click();assert.equal(await page.locator('#name').inputValue(),'Changed name');
   } else {
    await cards.first().locator('h3 > button').first().click();await page.waitForTimeout(100);
   }
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${pageName} open overflow at ${width}`);assert.deepEqual(errors,[],pageName);assert.equal(writes.length,0);
   if(pageName==='account') {await page.locator('#profile > h3 > button').click();await page.evaluate(()=>document.querySelector("main").scrollTop=0);await page.screenshot({path:`/tmp/mailflare-settings-account-${width}.png`});}
   if(pageName==='inbox') {await page.locator('#paperless > h3 > button').click();await page.evaluate(()=>document.querySelector("main").scrollTop=0);await page.screenshot({path:`/tmp/mailflare-settings-inbox-${width}.png`});}
   if(width<768) {
    const dock=page.locator('[data-settings-mobile-nav]'),more=dock.getByRole('button',{name:'Einstellungsmenü',exact:true});
    assert(await dock.isVisible());assert.equal(await dock.getByRole('link').count(),3);assert.equal(await dock.getByRole('link',{name:'Postfach',exact:true}).getAttribute('href'),'/inbox');
    assert.equal(await dock.getByRole('link',{name:'Konto',exact:true}).getAttribute('href'),'/settings/account');assert.equal(await dock.getByRole('link',{name:'Einstellungen: Posteingang',exact:true}).getAttribute('href'),'/settings/inbox');
    for(const target of await dock.locator('a,button').all()){const rect=await target.boundingBox();assert(rect.height>=48&&rect.width>=44);assert(rect.y>=900, 'navigation stays at bottom');}
    await page.locator('main').evaluate(el=>{el.scrollTop=el.scrollHeight});const scrollBefore=await page.locator('main').evaluate(el=>el.scrollTop);await more.click();
    const sheet=page.getByRole('dialog',{name:'Einstellungen',exact:true});await sheet.waitFor();await sheet.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));assert.equal(await sheet.getAttribute('aria-modal'),'true');assert.equal(await sheet.getByRole('link').count(),8);assert.equal(await sheet.locator('[aria-current="page"]').count(),1);
    for(const target of await sheet.locator('a,button').all()){const rect=await target.boundingBox();assert(rect.height>=48&&rect.width>=44,JSON.stringify({text:await target.textContent(),rect}));}
    for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert(await sheet.evaluate(el=>el.contains(document.activeElement)), 'focus stays in modal');}
    await page.mouse.move(10,10);await page.mouse.wheel(0,-400);await page.waitForTimeout(100);assert.equal(await page.locator('main').evaluate(el=>el.scrollTop),scrollBefore,'background remains still');
    await page.keyboard.press('Escape');await sheet.waitFor({state:'hidden'});await page.locator('.dialog-overlay').waitFor({state:'detached'});assert(await more.evaluate(el=>el===document.activeElement),'focus returns to bottom trigger');
    await more.click();await sheet.getByRole('button',{name:'Schließen',exact:true}).click();await sheet.waitFor({state:'hidden'});await page.locator('.dialog-overlay').waitFor({state:'detached'});if(pageName==='account')assert.equal(await page.locator('#name').inputValue(),'Changed name');
    await more.click();await Promise.all([page.waitForURL('**/settings/security'),sheet.getByRole('link',{name:'Sicherheit',exact:true}).click()]);assert.equal(await page.getByRole('dialog').count(),0);

   } else {assert.equal(await page.locator('aside a:visible').count(),8);assert.equal(await page.locator('aside [aria-current="page"]:visible').count(),1);}

   console.log(JSON.stringify({width,pageName,advancedTopicsCollapsedInitially:true,frequentOptionsDirectlyVisible:true,formsPreserved:true,noOverflow:true,noUnexpectedWrites:true}));await page.close();
  }
 }
 // Short screens, enlarged text, reduced motion and resizing exercise the bottom dock rather than a top selector.
 for(const options of [{width:320,height:568,fontScale:1},{width:390,height:844,fontScale:1},{width:667,height:375,fontScale:1},{width:320,height:700,fontScale:1.25}]) {
  const {width,height,fontScale}=options,page=await browser.newPage({viewport:{width,height},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(responseFor(new URL(route.request().url()).pathname))}));await page.goto(`${base}/settings/account`);await page.locator('#profile').waitFor();
  if(fontScale!==1)await page.evaluate(scale=>document.documentElement.style.fontSize=`${16*scale}px`,fontScale);
  const dock=page.locator('[data-settings-mobile-nav]'),more=dock.getByRole('button');assert(await dock.isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'large type must fit');
  await page.locator('#time-zone > h3 > button').click();const lastInput=page.locator('#time-zone-content').getByRole('combobox').last();await lastInput.scrollIntoViewIfNeeded();await lastInput.focus();const field=await lastInput.boundingBox(),bar=await dock.boundingBox();assert(field.y+field.height<=bar.y,'last form field stays above dock');
  await more.tap();const sheet=page.getByRole('dialog');await sheet.waitFor();assert.equal(await sheet.evaluate(el=>getComputedStyle(el).animationName),'none');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const close=sheet.getByRole('button',{name:'Schließen',exact:true}),rect=await close.boundingBox();assert(rect.y+rect.height<=height&&rect.y>=0,'close remains reachable on short screens');
  await page.screenshot({path:`/tmp/mailflare-mobile-settings-menu-${width}-${height}-${fontScale}.png`});await close.tap();await sheet.waitFor({state:'hidden'});await page.locator('.dialog-overlay').waitFor({state:'detached'});
  await page.locator('main').evaluate(el=>{el.scrollTop=0});await page.screenshot({path:`/tmp/mailflare-mobile-settings-account-${width}-${height}-${fontScale}.png`});
  await more.tap();await page.setViewportSize({width:1024,height:768});await sheet.waitFor({state:'hidden'});await page.locator('.dialog-overlay').waitFor({state:'detached'});assert.equal(await page.locator('aside a:visible').count(),8);await page.setViewportSize({width,height});assert.equal(await page.getByRole('dialog').count(),0,'resize must not reopen menu');
  console.log(JSON.stringify({...options,thumbReach:true,focusNotCovered:true,reducedMotion:true,resizeClosesMenu:true}));await page.close();
 }
 // Deep links must open the intended section, including the OAuth return destination.
 for(const [path,id] of [['inbox#paperless','paperless'],['import?gmail=connected#gmail-import','gmail-import'],['inbox#auto-reply','auto-reply']]) {
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(responseFor(new URL(route.request().url()).pathname))}));await page.goto(`${base}/settings/${path}`);await page.locator(`#${id} > h3 > button[aria-expanded="true"]`).waitFor();assert.equal(await page.locator('[data-settings-section] > h3 > button[aria-expanded="true"]').count(),1);await page.close();console.log(JSON.stringify({path,deepLinkOpensTarget:true}));
 }
} finally {
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});
}
