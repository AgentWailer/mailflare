// Actual API key settings and production CSS, with synthetic login/key/grant APIs.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const dir=mkdtempSync(join(process.cwd(),'node_modules','mcp-oauth-browser-')),de=JSON.parse(readFileSync('public/locales/de.json','utf8'));let browser;
writeFileSync(join(dir,'mailboxes.ts'),`export const useSelectedMailbox=()=>({mailboxes:[{id:'box',localPart:'owner',hostname:'example.test',permission:'full_access'}],selectedMailbox:{id:'box',localPart:'owner',hostname:'example.test',permission:'full_access'}});`);
try{
 await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LanguageProvider} from './src/components/language-provider';import {ApiKeysSettings} from './src/components/settings/api-keys-settings';import de from './public/locales/de.json';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageProvider initialLocale="de" initialMessages={de}><main className="p-4"><ApiKeysSettings/></main></LanguageProvider></QueryClientProvider>);`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(dir,'app.js'),bundle:true,platform:'browser',format:'esm',tsconfig:'tsconfig.json',alias:{'@/components/mailbox-provider':join(dir,'mailboxes.ts')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const cssDir='dist/client/_next/static/css',css=readFileSync(join(cssDir,readdirSync(cssDir).find(name=>name.startsWith('index.')&&name.endsWith('.css'))));
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const viewport of [{width:320,height:700},{width:390,height:844},{width:820,height:1180},{width:1440,height:900}]){
  const page=await browser.newPage({viewport}),errors=[],changes=[];page.on('pageerror',error=>errors.push(error.message));
  let failStatus=false,status={configured:true,serverUrl:'https://mailflare.test/mcp',identity:null,identityStatus:'missing_assertion',identitySource:'cookie',grant:null};
  const key=(id,name,kind,scopes)=>({id,name,kind,scopes:JSON.stringify(scopes),mailboxIds:['box'],mailboxScopeEnabled:true,prefix:'ep_test',createdAt:'2026-10-25T12:00:00Z',lastUsedAt:null});
  const keys=[key('mail-key','ChatGPT Mail','mcp',['mcp:read','mcp:calendar-read']),key('calendar-key','Calendar only','mcp',['mcp:calendar-read']),key('admin-key','Admin must not be offered','mcp',['domains']),key('legacy','Legacy API','legacy',['read'])];
  await page.route('https://mailflare.test/**',async route=>{const request=route.request(),url=new URL(request.url());let data;
   if(url.pathname==='/api/auth/me')data={user:{id:'owner',email:'owner@example.test',name:'Owner'}};
   else if(url.pathname==='/api/api-keys')data={apiKeys:keys};
   else if(url.pathname==='/api/settings/mcp-oauth'){
    if(failStatus)return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'invalid_token'})});
    if(request.method()==='POST'){const input=request.postDataJSON();changes.push(input);assert.deepEqual(Object.keys(input).sort(),input.enabled?['enabled','keyId']:['enabled']);status={...status,grant:input.enabled?{keyId:input.keyId,enabled:true,email:status.identity.email,identityMatches:true}:{...status.grant,enabled:false}};}
    data=status;
   }
   if(data)return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   return route.fulfill({contentType:url.pathname==='/app.js'?'text/javascript':url.pathname==='/app.css'?'text/css':'text/html',body:url.pathname==='/app.js'?readFileSync(join(dir,'app.js')):url.pathname==='/app.css'?css:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>'});
  });
  await page.goto('https://mailflare.test/settings/api-keys');const select=page.getByRole('combobox',{name:de['mcp.oauth.permissions'],exact:true});await select.waitFor();assert.deepEqual(await select.locator('option').allTextContents(),['ChatGPT Mail','Calendar only']);assert.equal(changes.length,0,'viewing or selecting permissions never grants access automatically');
  const enable=page.getByRole('button',{name:de['mcp.oauth.enable'],exact:true});assert(await enable.isDisabled());await page.getByText(de['mcp.oauth.diagnostics'],{exact:true}).click();assert(await page.getByText('missing_assertion (cookie)',{exact:true}).isVisible());status={...status,identity:{email:'google-login@example.test'},identityStatus:'verified'};await page.getByRole('button',{name:de['mcp.oauth.recheck'],exact:true}).click();await enable.click();await page.getByText(de['mcp.oauth.active'],{exact:true}).waitFor();assert.deepEqual(changes[0],{enabled:true,keyId:'mail-key'});
  await select.selectOption('calendar-key');assert.equal(changes.length,1);await page.getByRole('button',{name:de['mcp.oauth.update'],exact:true}).click();await page.waitForFunction(()=>document.querySelector('select')?.value==='calendar-key');assert.deepEqual(changes.at(-1),{enabled:true,keyId:'calendar-key'});
  await page.reload();await page.getByText(de['mcp.oauth.active'],{exact:true}).waitFor();assert.equal(await select.inputValue(),'calendar-key');
  await page.getByText(de['mcp.oauth.connect'],{exact:true}).click();assert(await page.getByText('https://mailflare.test/mcp',{exact:true}).isVisible());
  await page.screenshot({path:`/tmp/mailflare-mcp-oauth-${viewport.width}.png`});const overflow=await page.evaluate(()=>[...document.querySelectorAll('main *')].filter(element=>element.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(element=>({tag:element.tagName,className:element.className,text:element.textContent.slice(0,70),right:element.getBoundingClientRect().right})));assert.deepEqual(overflow,[]);
  // Revocation remains available even if Access identity cannot currently be verified.
  status={...status,identity:null,identityStatus:'certificates_unavailable'};await page.reload();const revoke=page.getByRole('button',{name:de['mcp.oauth.disable'],exact:true});await revoke.waitFor();assert(await revoke.isEnabled());assert(await page.getByRole('button',{name:de['mcp.oauth.update'],exact:true}).isDisabled());await revoke.click();await enable.waitFor();assert(await enable.isDisabled());assert.equal(status.grant.enabled,false);assert(await page.getByText(de['mcp.oauth.certsUnavailable'],{exact:true}).isVisible());
  await page.evaluate(()=>localStorage.setItem('mailflare-session-token','synthetic-session'));failStatus=true;await page.reload();await page.getByRole('button',{name:de['labels.visibility.retry'],exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/settings/api-keys');assert.equal(await page.evaluate(()=>localStorage.getItem('mailflare-session-token')),'synthetic-session');failStatus=false;
  status={configured:false,serverUrl:'https://mailflare.test/mcp',identity:null,grant:null};await page.reload();await page.getByText(de['mcp.oauth.setup'],{exact:true}).click();assert(await page.getByText(de['mcp.oauth.setupHelp'],{exact:true}).isVisible());assert.equal(await enable.count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport,explicitConsent:true,mailAndCalendarKeysOnly:true,persistsOnReload:true,revocableWithoutAccessIdentity:true,identityRecheckRecovers:true,accessChallengePreservesLocalSession:true,noOverflow:true}));await page.close();
 }
}finally{await browser?.close();rmSync(dir,{recursive:true,force:true});}
