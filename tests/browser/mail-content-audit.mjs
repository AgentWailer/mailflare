import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),dir=mkdtempSync(join(root,'node_modules','audit-browser-'));
writeFileSync(join(dir,'link.tsx'),'export default function Link({children,...props}){return <a {...props}>{children}</a>}');
writeFileSync(join(dir,'entry.tsx'),`import {createRoot} from 'react-dom/client';import {LanguageProvider} from '../../src/components/language-provider';import {MailContentAudit} from '../../src/components/settings/mail-content-audit';import messages from '../../public/locales/de.json';createRoot(document.getElementById('root')).render(<LanguageProvider initialLocale="de" initialMessages={messages}><main style={{maxWidth:900,margin:'auto',padding:16}}><MailContentAudit mailboxId="box"/></main></LanguageProvider>);`);
const de=JSON.parse(readFileSync(join(root,'public/locales/de.json'),'utf8'));
const cssDir=join(root,'dist/client/_next/static/css'),css=readFileSync(join(cssDir,readdirSync(cssDir).find(f=>f.startsWith('index.')&&f.endsWith('.css'))));
let server,browser;
try{
 await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'next/link':join(dir,'link.tsx')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(path==='/fixture.js'?readFileSync(join(dir,'fixture.js')):path==='/fixture.css'?css:'<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of [320,1440]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[],actions=[];page.on('pageerror',e=>errors.push(e.message));
  let state={job:{id:'job',status:'waiting',phase:'ai',total:63899,processed:63899,aiProcessed:12,changed:17,reviewCount:1,error:'daily_limit'},issues:[{id:'issue',messageId:'message',category:'promotions',suggestedCategory:'invoices',subject:'Ihre nächste Rate wird abgebucht',sender:'PayPal <service@paypal.test>',snippet:'Ihre nächste Zahlung von 80 € wird automatisch abgebucht.',reason:'uncertain'}],next:null};
  await page.route('**/api/**',route=>{const req=route.request();if(req.method()==='POST'){const action=req.postDataJSON();actions.push(action);if(action.action==='review')state={...state,issues:[]};if(action.action==='pause')state={...state,job:{...state.job,status:'paused'}};if(action.action==='resume')state={...state,job:{...state.job,status:'pending'}};return route.fulfill({contentType:'application/json',body:'{"ok":true}'});}return route.fulfill({contentType:'application/json',body:JSON.stringify(state)});});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('link',{name:state.issues[0].subject}).waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.getByLabel(de['audit.chooseCategory']).inputValue(),'invoices');await page.getByRole('button',{name:de['audit.pause'],exact:true}).click();await page.getByRole('button',{name:de['audit.resume'],exact:true}).waitFor();await page.getByRole('button',{name:de['audit.resume'],exact:true}).click();await page.getByRole('button',{name:de['audit.confirm'],exact:true}).click();await page.waitForFunction(()=>!document.querySelector('select'));assert.equal(actions.at(-1).category,'invoices');
  await page.getByRole('button',{name:de['audit.structure'],exact:true}).click();await page.getByText(de['audit.structureSaved'],{exact:true}).waitFor();assert.deepEqual(errors,[]);
  await page.screenshot({path:`/tmp/mailflare-content-audit-${width}.png`});console.log(JSON.stringify({width,reviewConfirmed:true,pauseResume:true,structureSaved:true,noOverflow:true}));await page.close();
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
