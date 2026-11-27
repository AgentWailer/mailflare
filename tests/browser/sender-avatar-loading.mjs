// Actual sender/contact avatar components; synthetic contacts, real bundled artwork.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {deflateSync,crc32} from 'node:zlib';
import {readProductionCss} from './helpers/production-css.mjs';
// A 32x32 logo as many sites publish it: a small opaque mark (red) on a fully transparent ground.
function transparentLogo(){
 const size=32,raw=Buffer.alloc(size*(size*4+1));
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(x>=14&&x<18&&y>=14&&y<18){const at=y*(size*4+1)+1+x*4;raw[at]=220;raw[at+1]=0;raw[at+2]=0;raw[at+3]=255;}
 const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(body.length+8);out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body)>>>0,body.length+4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const temporary=mkdtempSync(join(process.cwd(),'node_modules','avatar-browser-'));
await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {SenderAvatar} from './src/components/messages/sender-avatar';function App(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(!open)}>Open message</button><section key={String(open)} data-reader={open}><SenderAvatar mailboxId="box" address="Apple <receipt@apple.com>" name="Apple" hasAvatar={false} priority={open}/></section></>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(temporary,'app.js'),bundle:true,platform:'browser',format:'esm',tsconfig:'tsconfig.json',logLevel:'silent'});
await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SenderAvatar} from './src/components/messages/sender-avatar';createRoot(document.getElementById('root')).render(<div style={{padding:24}}><SenderAvatar mailboxId="box" address="Hejfish <news@fischladen-beispiel.de>" name="Hejfish" hasAvatar={false} className="h-12 w-12"/></div>);`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(temporary,'logo.js'),bundle:true,platform:'browser',format:'esm',tsconfig:'tsconfig.json',logLevel:'silent'});
const logo=transparentLogo(),css=readProductionCss();
let artworkRequests=0,privatePhotoRequests=0,previewRequests=0;
const server=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 if(url.searchParams.has('variant'))previewRequests++;
 if(url.pathname==='/api/contacts/logo'){response.writeHead(200,{'Content-Type':'image/png'});response.end(logo);return;}
 if(url.pathname==='/logo.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end(readFileSync(join(temporary,'logo.js')));return;}
 if(url.pathname==='/app.css'){response.writeHead(200,{'Content-Type':'text/css'});response.end(css);return;}
 if(url.pathname==='/transparent-logo'){response.writeHead(200,{'Content-Type':'text/html'});response.end(`<!doctype html><html class="${url.searchParams.get('theme')}"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/logo.js"></script></body></html>`);return;}
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
 // A logo with a transparent ground must not let the initial or its colour show through, in either theme.
 for(const theme of ['dark','light']){
  const page=await browser.newPage({viewport:{width:390,height:300},deviceScaleFactor:2}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/transparent-logo?theme=${theme}`);
  const avatar=page.locator('#root span').first();
  await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0&&document.querySelector('[data-avatar-picture]'));
  assert.equal(await avatar.textContent(),'','the initial is gone once the logo is shown');
  const shot=(await avatar.screenshot()).toString('base64');
  // Decode the screenshot in the page: the centre is the logo's mark, everything else inside the circle its ground.
  const pixels=await page.evaluate(async data=>{const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);const at=(x,y)=>[...context.getImageData(Math.round(image.width*x),Math.round(image.height*y),1,1).data].slice(0,3);return {centre:at(.5,.5),left:at(.25,.5),right:at(.75,.5),top:at(.5,.25),bottom:at(.5,.75)};},shot);
  assert(pixels.centre[0]>180&&pixels.centre[1]<60&&pixels.centre[2]<60,`the logo's own mark is drawn (${pixels.centre})`);
  for(const side of ['left','right','top','bottom'])assert.deepEqual(pixels[side],[255,255,255],`${theme}: the ${side} of a transparent logo is white, not the placeholder (${pixels[side]})`);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({theme,transparentLogoGround:'white',initialHidden:true}));await page.close();
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));rmSync(temporary,{recursive:true,force:true});}
