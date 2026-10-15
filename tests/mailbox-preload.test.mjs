import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('',{url:'https://mailflare.test/inbox',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','Event','CustomEvent','navigator'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
const directory=mkdtempSync(join(process.cwd(),'node_modules','mailbox-preload-test-'));
after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
await build({stdin:{contents:`export {startMailboxPreload} from './src/components/messages/mailbox-preload';export {getMailboxPageParams,preloadMailboxPage} from './src/components/components-nav-utils';export {fetchMessageList,fetchMessageCounts,getCachedMessageList,clearMessageClientState,clearMessageListCache} from './src/hooks/utils';export {clearMailboxFoldersCache} from './src/components/messages/use-mailbox-folders';export {setClientSessionToken} from './src/lib/auth/client';`,resolveDir:process.cwd()},outfile:join(directory,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const app=await import(pathToFileURL(join(directory,'app.mjs')).href);
const result=id=>Response.json({messages:[{id}],total:1,limit:25,offset:0});
async function fixture(t,fetcher){
 localStorage.clear();app.clearMessageClientState();app.clearMailboxFoldersCache();
 let clock=1000,id=0,visible='visible',online=true;const timers=new Map(),routes=[],calls=[];
 const connection=new window.EventTarget();connection.saveData=false;
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible});Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>online});Object.defineProperty(navigator,'connection',{configurable:true,value:connection});
 t.mock.method(Date,'now',()=>clock);t.mock.method(window,'setTimeout',(fn,ms=0)=>{const handle=++id;timers.set(handle,{at:clock+ms,fn});return handle;});t.mock.method(window,'clearTimeout',handle=>timers.delete(handle));
 Object.defineProperty(window,'requestIdleCallback',{configurable:true,value:fn=>window.setTimeout(()=>fn({timeRemaining:()=>20}),0)});Object.defineProperty(window,'cancelIdleCallback',{configurable:true,value:handle=>window.clearTimeout(handle)});
 t.mock.method(globalThis,'fetch',(url,init)=>{calls.push({url:String(url),init});return fetcher?fetcher(String(url),init):Promise.resolve(String(url).includes('/api/folders')?Response.json({folders:[{id:'work',name:'Work'}]}):result('warm'));});
 let stop;const start=(options={})=>(stop=app.startMailboxPreload({mailboxId:'box',href:'/inbox',grouped:true,prefetchRoute:href=>routes.push(href),...options}));t.after(()=>stop?.());
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 async function advance(ms){const end=clock+ms;for(let i=0;i<500;i++){await flush();const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due){clock=end;await flush();return;}clock=due[1].at;timers.delete(due[0]);due[1].fn();}throw Error('timer loop');}
 return {start,advance,flush,calls,routes,connection,timers,hide:()=>{visible='hidden';document.dispatchEvent(new Event('visibilitychange'));},show:()=>{visible='visible';document.dispatchEvent(new Event('visibilitychange'));},offline:()=>{online=false;},online:()=>{online=true;window.dispatchEvent(new Event('online'));}};
}

test('All mail warms first after a quiet paint interval; folders and labels are serial first pages',async t=>{
 const f=await fixture(t);f.start();await f.advance(749);assert.equal(f.calls.length,0);await f.advance(10000);
 const lists=f.calls.filter(call=>call.url.startsWith('/api/messages?'));assert.equal(lists.length,14,'13 other system folders and one label');assert.equal(f.routes[0],'/all');assert(f.routes.includes('/folders/work'));
 for(const {url,init}of lists){const p=new URL(url,'https://mailflare.test').searchParams;assert.equal(p.get('limit'),'25');assert(!p.has('offset'));assert.equal(init.priority,'low');assert.equal(new Headers(init.headers).get('X-Mailflare-Preload'),'1');}
 assert.equal(new URL(lists[0].url,'https://mailflare.test').searchParams.get('status'),null);assert.equal(new URL(lists[0].url,'https://mailflare.test').searchParams.get('direction'),'inbound');assert.equal(f.timers.size,0,'completed warming leaves no polling timer');
});

test('a foreground click joins a pending preload; no second list starts while it is unresolved',async t=>{
 let release;const f=await fixture(t,()=>new Promise(resolve=>release=resolve));f.start();await f.advance(1000);assert.equal(f.calls.length,1);
 const foreground=app.preloadMailboxPage('/all','box');await f.advance(5000);assert.equal(f.calls.length,1);
 release(result('all-ready'));await foreground;await f.flush();assert.equal(app.getCachedMessageList(app.getMailboxPageParams('/all','box')).messages[0].id,'all-ready');
});

test('foreground counters and recent scrolling delay speculative work',async t=>{
 let release;const f=await fixture(t,(url)=>url.includes('/counts')?new Promise(resolve=>release=resolve):Promise.resolve(result('ready')));
 const counts=app.fetchMessageCounts('box');f.start();await f.advance(2000);assert.equal(f.calls.length,1);
 release(Response.json({counts:{folders:{}}}));await counts;window.dispatchEvent(new Event('wheel'));await f.advance(749);assert.equal(f.calls.length,1);await f.advance(500);assert(f.calls.length>1);
});

test('hidden, offline and data-saving pages pause the queue and resume when eligible',async t=>{
 const f=await fixture(t);f.connection.saveData=true;f.start();await f.advance(3000);assert.equal(f.calls.length,0);
 f.connection.saveData=false;f.hide();f.connection.dispatchEvent(new Event('change'));await f.advance(1000);assert.equal(f.calls.length,0);
 f.offline();f.show();await f.advance(1000);assert.equal(f.calls.length,0);f.online();await f.advance(1000);assert(f.calls.length>0);
});

test('navigation cleanup and account replacement stop the queue and reject late cache writes',async t=>{
 let release;const f=await fixture(t,()=>new Promise(resolve=>release=resolve));app.setClientSessionToken('old');const stop=f.start();await f.advance(1000);assert.equal(f.calls.length,1);stop();
 app.setClientSessionToken('new');release(result('old-private'));await f.flush();await f.advance(5000);assert.equal(f.calls.length,1);assert.equal(app.getCachedMessageList(app.getMailboxPageParams('/all','box')),undefined);
});

test('cached pages are skipped, failed warming stays retryable and prefetched results expire',async t=>{
 let requests=0;const f=await fixture(t,async url=>url.includes('/folders')?Response.json({folders:[]}):++requests===1?new Response('',{status:503}):result('fresh'));
 f.start();await f.advance(1000);assert.equal(app.getCachedMessageList(app.getMailboxPageParams('/all','box')),undefined);
 await app.preloadMailboxPage('/all','box');assert.equal(requests,2);assert.equal(app.getCachedMessageList(app.getMailboxPageParams('/all','box')).messages[0].id,'fresh');
 const params=app.getMailboxPageParams('/invoices','box');await app.fetchMessageList(params,false,true);assert(app.getCachedMessageList(params));await f.advance(121000);assert.equal(app.getCachedMessageList(params),undefined);
 app.clearMessageListCache();assert.equal(app.getCachedMessageList(app.getMailboxPageParams('/all','box')),undefined);
});

test('grouping follows preferences and cached data cannot cross a raw storage session change',async t=>{
 const f=await fixture(t);f.start({grouped:false});await f.advance(1000);assert(!new URL(f.calls[0].url,'https://mailflare.test').searchParams.has('group'));
 const params=app.getMailboxPageParams('/all','box',false);assert(app.getCachedMessageList(params));localStorage.setItem('mailflare-session-token','other-tab-account');assert.equal(app.getCachedMessageList(params),undefined);
 assert.equal(app.getMailboxPageParams('/folders/work%20files','box').get('folderId'),'work files');assert.equal(app.getMailboxPageParams('/settings/account','box'),undefined);
});

test('browsers without requestIdleCallback use the quiet timer fallback',async t=>{
 const f=await fixture(t);Object.defineProperty(window,'requestIdleCallback',{configurable:true,value:undefined});
 f.start();await f.advance(749);assert.equal(f.calls.length,0);await f.advance(1);assert.equal(f.routes[0],'/all');assert.equal(f.calls.length,1);
});
