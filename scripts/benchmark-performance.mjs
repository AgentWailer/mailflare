// Production build, synthetic private APIs, real browser cache. Never sends load to production.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join,dirname} from 'node:path';
const {chromium}=await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE||'playwright');
const runs=Number(process.env.PERF_RUNS||5),output=process.env.PERF_OUTPUT||'/tmp/mailflare-performance.json';
const temporary=mkdtempSync(join(tmpdir(),'mailflare-perf-')),pause=ms=>new Promise(r=>setTimeout(r,ms));
const folders=['inbox','promotions','social','invoices','orders','starred','all','snoozed','sent','scheduled','drafts','archived','spam','trash'];
const counts={folders:Object.fromEntries(folders.map(k=>[k,{total:60000,unread:15}])),customFolders:{},mailboxes:[]};
const mail=id=>({id,mailboxId:'bench-box',direction:'inbound',status:'received',category:'primary',read:true,starred:false,fromAddr:'Sender <sender@example.test>',toAddr:'owner@example.test',subject:'Benchmark mail '+id,snippet:'A readable preview of your receipt.',labels:[],createdAt:'2026-10-25T12:00:00Z'});
const messages=Array.from({length:25},(_,i)=>mail(String(i)));
function fixture(url){const path=url.pathname;
 if(path==='/api/auth/me')return {user:{id:'bench-user',email:'owner@example.test',name:'Test User',role:'admin',isPrimaryAdmin:true,hasAvatar:false},hasMailboxes:true,isSetup:true};
 if(path==='/api/mailboxes')return {mailboxes:[{id:'bench-box',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Test User',isPrimary:true,type:'personal',permission:'full_access',senderAddresses:['owner@example.test']}]};
 if(path==='/api/messages')return {messages,total:60000,offset:0,limit:25};
 if(path==='/api/messages/navigation')return {messages:messages.map(m=>({id:m.id,unread:false})),previousId:null,nextId:'1',position:1,total:60000};
 if(/^\/api\/messages\/\d+$/.test(path)){const id=path.split('/').at(-1);return {message:mail(id),body:{textBody:'Benchmark message content '+id,htmlBody:null},attachments:[]};}
 if(path==='/api/messages/counts')return {counts};
 if(path==='/api/branding')return {appName:'Mailflare',hasCustomIcon:false};
 if(path==='/api/agent/availability')return {enabled:true};
 if(path==='/api/agent/settings')return {settings:{mailboxId:'bench-box',enabled:true,dailyLimit:100},models:[],canManage:true,providerConfigured:true,reviewers:[]};
 return {folders:[],accounts:[],jobs:[],job:null,messages:[],hiddenLabelIds:[],ok:true};
}
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
const reserve=createServer(),previewPort=await listen(reserve);await new Promise(r=>reserve.close(r));
let preview,browser,proxy,logs='';const results=[];
try{
 preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(previewPort)],{env:{...process.env,XDG_CONFIG_HOME:temporary,CLOUDFLARE_REMOTE_BINDINGS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [preview.stdout,preview.stderr])stream.on('data',b=>logs+=b);
 let ready=false;for(let i=0;i<150;i++){try{if((await fetch(`http://127.0.0.1:${previewPort}/inbox`,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}if(preview.exitCode!==null)throw Error('Preview exited');await pause(200);}assert(ready);
 proxy=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname.startsWith('/api/')){await pause(100);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'private, no-store'});return res.end(JSON.stringify(fixture(url)));}
  const upstream=httpRequest({hostname:'127.0.0.1',port:previewPort,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${previewPort}`}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
 });const port=await listen(proxy),origin=`http://127.0.0.1:${port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.MAILFLARE_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of [390,1440])for(let run=0;run<runs;run++){
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<768,locale:'de-DE'});
  await context.addInitScript(()=>{
   window.__perf={lcp:0,cls:0,longTasks:[],events:[]};let session=0,last=0,start=0;
   new PerformanceObserver(list=>{for(const e of list.getEntries()){window.__perf.lcp=e.startTime;window.__perf.lcpElement=e.element?.tagName;}}).observe({type:'largest-contentful-paint',buffered:true});
   new PerformanceObserver(list=>{for(const e of list.getEntries()){if(e.hadRecentInput)continue;if(e.startTime-last>1000||e.startTime-start>5000){session=0;start=e.startTime;}session+=e.value;last=e.startTime;window.__perf.cls=Math.max(window.__perf.cls,session);}}).observe({type:'layout-shift',buffered:true});
   new PerformanceObserver(list=>{for(const e of list.getEntries())window.__perf.longTasks.push(e.duration);}).observe({type:'longtask',buffered:true});
   new PerformanceObserver(list=>{for(const e of list.getEntries())if(e.interactionId)window.__perf.events.push(e.duration);}).observe({type:'event',buffered:true,durationThreshold:16});
  });
  const page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[];page.on('pageerror',e=>errors.push(e.message));await cdp.send('Network.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:1500000,uploadThroughput:750000});
  for(const cache of ['cold','warm']){
   await cdp.send('Network.setCacheDisabled',{cacheDisabled:cache==='cold'});
   if(cache==='cold')await cdp.send('Network.clearBrowserCache');
   const tracing=process.env.PERF_TRACE==='1'&&width===390&&run===0&&cache==='cold';
   if(tracing)await cdp.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing,v8',transferMode:'ReturnAsStream'});
   const requests=new Map();let cacheHits=0;const onResponse=({requestId,response,type})=>requests.set(requestId,{path:new URL(response.url).pathname,type,status:response.status,protocol:response.protocol,cache:!!response.fromDiskCache||!!response.fromPrefetchCache});
   const onCache=()=>cacheHits++;const onFinish=({requestId,encodedDataLength})=>{const r=requests.get(requestId);if(r)r.transfer=encodedDataLength;};
   cdp.on('Network.responseReceived',onResponse);cdp.on('Network.requestServedFromCache',onCache);cdp.on('Network.loadingFinished',onFinish);
   const began=performance.now();await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded',timeout:60000});await page.locator('[data-message-row="0"]').waitFor();const listMs=performance.now()-began;await pause(Number(process.env.PERF_READER_IDLE_MS||500));
   const startup=await page.evaluate(()=>({metrics:window.__perf,nav:performance.getEntriesByType('navigation')[0].toJSON(),resources:performance.getEntriesByType('resource').map(r=>({path:new URL(r.name).pathname,bytes:r.transferSize,encoded:r.encodedBodySize,decoded:r.decodedBodySize,duration:r.duration}))}));
   const assets=[...requests.values()].filter(r=>r.type==='Script'||r.type==='Stylesheet'),startupRequests=requests.size;
   const beforeReader=new Set(requests.keys());const click=performance.now();await page.locator('[data-message-row="0"] a').first().click();await page.getByText('Benchmark message content 0',{exact:true}).waitFor();const readerMs=performance.now()-click;await pause(100);
   const readerAssets=[...requests.entries()].filter(([id,r])=>!beforeReader.has(id)&&r.type==='Script').map(([,r])=>r);
   const interaction=await page.evaluate(()=>Math.max(0,...window.__perf.events));assert.deepEqual(errors,[]);
   const sum=type=>assets.filter(r=>r.type===type).reduce((n,r)=>n+(r.transfer||0),0);
   const row={width,run,cache,listMs,readerMs,readerJsTransferBytes:readerAssets.reduce((n,r)=>n+(r.transfer||0),0),readerAssets,lcpMs:startup.metrics.lcp,cls:startup.metrics.cls,labInteractionMaxMs:interaction,ttfbMs:startup.nav.responseStart-startup.nav.requestStart,jsTransferBytes:sum('Script'),cssTransferBytes:sum('Stylesheet'),imageTransferBytes:startup.resources.filter(r=>/\.(png|svg|webp|jpg)$/.test(r.path)).reduce((n,r)=>n+r.bytes,0),requestCount:startupRequests,browserCacheHits:cacheHits,longTaskTotalMs:startup.metrics.longTasks.reduce((n,d)=>n+d,0),maxLongTaskMs:Math.max(0,...startup.metrics.longTasks),apis:startup.resources.filter(r=>r.path.startsWith('/api/')),assets:assets.sort((a,b)=>(b.transfer||0)-(a.transfer||0))};results.push(row);console.log(JSON.stringify({...row,assets:undefined,apis:undefined,readerAssets:undefined}));
   if(tracing){const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;let trace='';while(true){const part=await cdp.send('IO.read',{handle:stream});trace+=part.base64Encoded?Buffer.from(part.data,'base64').toString():part.data;if(part.eof)break;}await cdp.send('IO.close',{handle:stream});mkdirSync(dirname(output),{recursive:true});writeFileSync(output.replace(/\.json$/,'.trace.json'),trace);}
   cdp.off('Network.responseReceived',onResponse);cdp.off('Network.requestServedFromCache',onCache);cdp.off('Network.loadingFinished',onFinish);
  }
  await context.close();
 }
 const p=(values,q)=>{const sorted=values.toSorted((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)];};
 const summaries=[];for(const width of [390,1440])for(const cache of ['cold','warm']){const rows=results.filter(r=>r.width===width&&r.cache===cache),summary={width,cache,runs:rows.length};for(const key of ['listMs','readerMs','readerJsTransferBytes','lcpMs','ttfbMs','labInteractionMaxMs','cls','jsTransferBytes','cssTransferBytes','requestCount','browserCacheHits','longTaskTotalMs'])summary[key]={p50:p(rows.map(r=>r[key]),.5),p75:p(rows.map(r=>r[key]),.75),p95:p(rows.map(r=>r[key]),.95)};summaries.push(summary);}
 mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({kind:'controlled lab; synthetic 100ms APIs; production assets; preview without HTTP compression; browser HTTP/1.1; INP field data unavailable',commit:process.env.PERF_COMMIT||'working-tree',createdAt:new Date().toISOString(),machine:{cpu:cpus()[0]?.model,cores:cpus().length,node:process.version,browser:browser.version()},conditions:{readerIdleMs:Number(process.env.PERF_READER_IDLE_MS||500),trace:process.env.PERF_TRACE==='1',runs,cpuThrottle:4,rttMs:100,downloadBytesPerSecond:1500000,uploadBytesPerSecond:750000},summaries,results},null,2));console.log('Saved '+output);
 if(process.env.PERF_CHECK==='1')for(const r of results){assert(r.cls<=.1,'CLS budget');assert(r.jsTransferBytes<1_300_000,'startup JavaScript budget');assert(r.cssTransferBytes<140_000,'CSS budget');assert(r.requestCount<=110,'startup request budget');assert(r.readerMs<3000,'reader interaction budget');assert(r.readerJsTransferBytes<400_000,'first-reader JavaScript budget');if(r.cache==='warm')assert(r.browserCacheHits>0,'warm-cache measurement must actually hit browser cache');}
}finally{await browser?.close();await new Promise(r=>proxy?proxy.close(r):r());if(preview){preview.kill('SIGTERM');await new Promise(r=>{if(preview.exitCode!==null)return r();preview.once('exit',r);setTimeout(()=>{preview.kill('SIGKILL');r();},5000).unref();});}writeFileSync('/tmp/mailflare-performance-preview.log',logs);rmSync(temporary,{recursive:true,force:true});}
