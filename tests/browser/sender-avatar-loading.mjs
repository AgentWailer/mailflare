// Actual sender/contact avatar components; synthetic contacts, real bundled artwork.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(process.cwd(),'node_modules','avatar-browser-'));
await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {SenderAvatar} from './src/components/messages/sender-avatar';function App(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(!open)}>Open message</button><section key={String(open)} data-reader={open}><SenderAvatar mailboxId="box" address="Apple <receipt@apple.com>" name="Apple" hasAvatar={false} priority={open}/></section></>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(temporary,'app.js'),bundle:true,platform:'browser',format:'esm',tsconfig:'tsconfig.json',logLevel:'silent'});
let artworkRequests=0,privatePhotoRequests=0,previewRequests=0;
const server=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 if(url.searchParams.has('variant'))previewRequests++;
 if(url.pathname.startsWith('/api/')){privatePhotoRequests++;response.writeHead(404);response.end();return;}
 if(url.pathname==='/sender-logos/apple.svg'){artworkRequests++;response.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});response.end(readFileSync('public/sender-logos/apple.svg'));return;}
 if(url.pathname==='/app.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end(readFileSync(join(temporary,'app.js')));return;}
 response.writeHead(200,{'Content-Type':'text/html'});response.end('<div id="root"></div><script type="module" src="/app.js"></script>');
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',error=>errors.push(error.message));const before=artworkRequests;
  await page.goto(origin);await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);
  assert.equal(artworkRequests,before+1);
  await page.getByRole('button',{name:'Open message'}).click();await page.waitForFunction(()=>document.querySelector('[data-reader=true] img')?.naturalWidth>0);
  const attributes=await page.locator('img').evaluate(image=>({src:image.getAttribute('src'),priority:image.fetchPriority,loading:image.loading,filter:getComputedStyle(image).filter}));
  assert.deepEqual(attributes,{src:'/sender-logos/apple.svg',priority:'high',loading:'eager',filter:'none'});
  assert.equal(artworkRequests,before+1,'opening the reader reuses the already downloaded logo');assert.equal(privatePhotoRequests,0);assert.equal(previewRequests,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({viewport,logoDownloads:1,readerUsesCachedLogo:true,unnecessaryPhotoRequests:0,blurredPreviews:0}));await page.close();
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));rmSync(temporary,{recursive:true,force:true});}
