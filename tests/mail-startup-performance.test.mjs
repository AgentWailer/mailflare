import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test/inbox',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','CustomEvent','Event','HTMLElement'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-startup-tests-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
const write=(name,source)=>{const path=join(dir,name);writeFileSync(path,source);return path;};
const navigation=write('navigation.ts',`export const usePathname=()=>'/inbox';export const useRouter=()=>({push:path=>globalThis.__navigations.push(path),prefetch:()=>{}});`);
const link=write('link.tsx',`import React from 'react';export default function Link({children,prefetch,...props}){return <a {...props}>{children}</a>}`);
const sidebar=write('sidebar.ts',`export const useSidebar=()=>({minimal:false,mobile:true,mobileOpen:true,toggle:()=>{}});`);
const mailbox=write('mailbox.ts',`export const useSelectedMailbox=()=>({selectedMailbox:{id:'box'}});`);
const compose=write('compose.ts',`export const useCompose=()=>({openComposer:()=>{}});`);
const branding=write('branding.ts',`export const useBranding=()=>({appName:'Mailflare',iconUrl:'/icon-96.png'});`);
await build({stdin:{contents:`export {NavItem} from './src/components/components-nav';export {LoadingTransition} from './src/components/loading-transition';export {usePageLoading} from './src/components/page-loading';export {getMessageQueryParams} from './src/hooks/utils';export {preloadMailboxPage} from './src/components/components-nav-utils';export {fetchMessageList,clearMessageListCache,fetchMessageCounts,clearMessageCountsCache,clearMessageClientState} from './src/hooks/utils';`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/navigation':navigation,'next/link':link,'@/components/sidebar-state':sidebar,'@/components/mailbox-provider':mailbox,'@/components/branding-provider':branding},plugins:[{name:'relative-fixture-contexts',setup(build){const mocks={'./sidebar-state':sidebar,'./mailbox-provider':mailbox,'./compose/compose-context':compose};build.onResolve({filter:/^\.(\/sidebar-state|\/mailbox-provider|\/compose\/compose-context)$/},args=>({path:mocks[args.path]}));}}],logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function reset(t,fetcher){app.clearMessageClientState();localStorage.clear();globalThis.__navigations=[];document.body.innerHTML='<div id="root"></div>';t.mock.method(globalThis,'fetch',fetcher);}

test('folder navigation happens immediately while the message request is unresolved',async t=>{
 let resolve;reset(t,()=>new Promise(r=>resolve=r));const root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 const Icon=()=>React.createElement('span');await act(async()=>root.render(React.createElement(app.NavItem,{link:{href:'/promotions',label:'Werbung',icon:Icon,preloadMessages:true}})));
 await act(async()=>document.querySelector('a').dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})));
 assert.deepEqual(globalThis.__navigations,['/promotions']);assert(resolve,'data request started without blocking the route');await act(async()=>resolve(Response.json({messages:[],total:0})));
});

test('authenticated startup reveals the shell even while message loading stays pending',async t=>{
 reset(t,async()=>Response.json({}));const root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 function PendingPage(){app.usePageLoading(true);return React.createElement('button',null,'Open menu');}
 await act(async()=>root.render(React.createElement(app.LoadingTransition,{ready:true},React.createElement(PendingPage))));
 await act(async()=>pause(100));await act(async()=>pause(950));
 const overlay=document.querySelector('[aria-live="polite"]');assert(overlay.className.includes('pointer-events-none'),'pending data must not retain the blocking splash');assert(document.querySelector('button').parentElement.className.includes('opacity-100'));
});

test('simultaneous forced counter refreshes share one in-flight query',async t=>{
 let resolve,calls=0;reset(t,()=>{calls++;return new Promise(r=>resolve=r);});
 const requests=[app.fetchMessageCounts('box',true),app.fetchMessageCounts('box',true),app.fetchMessageCounts('box',true)];assert.equal(calls,1);resolve(Response.json({counts:{version:1}}));assert.deepEqual(await Promise.all(requests),[{version:1},{version:1},{version:1}]);
});

test('invalidations during a counter query schedule exactly one fresh follow-up without stale cache',async t=>{
 const resolvers=[];let calls=0;reset(t,()=>{calls++;return new Promise(resolve=>resolvers.push(resolve));});const old=app.fetchMessageCounts('box');app.clearMessageCountsCache();const a=app.fetchMessageCounts('box',true),b=app.fetchMessageCounts('box',true);assert.equal(calls,1);
 resolvers[0](Response.json({counts:{version:1}}));await old;await pause(0);assert.equal(calls,2);resolvers[1](Response.json({counts:{version:2}}));assert.deepEqual(await Promise.all([a,b]),[{version:2},{version:2}]);assert.deepEqual(await app.fetchMessageCounts('box'),{version:2});assert.equal(calls,2);
});

test('an account change starts its own counters without waiting for the old account query',async t=>{
 const resolvers=[];let calls=0;reset(t,()=>{calls++;return new Promise(resolve=>resolvers.push(resolve));});const old=app.fetchMessageCounts('box');app.clearMessageClientState();localStorage.setItem('mailflare-session-token','new-account');const current=app.fetchMessageCounts('box');assert.equal(calls,2);
 resolvers[1](Response.json({counts:{account:'new'}}));await current;resolvers[0](Response.json({counts:{account:'old'}}));await old;assert.deepEqual(await app.fetchMessageCounts('box'),{account:'new'});
});


test('sidebar preloads share the exact default conversation-list request instead of fetching an unused single-mail page', async t=>{
 let resolve,calls=0,url;reset(t,(input)=>{calls++;url=String(input);return new Promise(r=>resolve=r);});
 const preload=app.preloadMailboxPage('/promotions','box');
 assert.equal(new URL(url,'https://mailflare.test').searchParams.get('group'),'thread');
 const params=app.getMessageQueryParams('promotions','box',{query:'',limit:25,offset:0,read:'all',group:'thread'});
 assert.equal(url,'/api/messages?'+params.toString());
 // A second preloader joins the same pending cache entry.
 const second=app.preloadMailboxPage('/promotions','box');assert.equal(calls,1);resolve(Response.json({messages:[],total:0,grouped:true}));await Promise.all([preload,second]);
 await app.preloadMailboxPage('/promotions','box');assert.equal(calls,1);
});

test('sidebar preloading follows disabled conversation grouping and keeps drafts ungrouped', async t=>{
 const urls=[];reset(t,async input=>{urls.push(String(input));return Response.json({messages:[],total:0});});localStorage.setItem('mailflare-conversation-view','off');
 await app.preloadMailboxPage('/social','box');assert.equal(new URL(urls[0],'https://mailflare.test').searchParams.get('group'),null);
 localStorage.setItem('mailflare-conversation-view','on');await app.preloadMailboxPage('/drafts','box');assert.equal(new URL(urls[1],'https://mailflare.test').searchParams.get('group'),null);
});


test('simultaneous forced list refreshes reuse one request',async t=>{
 let resolve,calls=0;reset(t,()=>{calls++;return new Promise(r=>resolve=r);});const params=new URLSearchParams('mailboxId=box');
 const all=[app.fetchMessageList(params,true),app.fetchMessageList(params,true),app.fetchMessageList(params,true)];assert.equal(calls,1);resolve(Response.json({messages:[{id:'fresh'}]}));assert.deepEqual(await Promise.all(all),Array(3).fill({messages:[{id:'fresh'}]}));
});

test('list invalidations wait for one fresh follow-up even if the previous query fails',async t=>{
 const pending=[];let calls=0;reset(t,()=>{calls++;return new Promise((resolve,reject)=>pending.push({resolve,reject}));});const params=new URLSearchParams('mailboxId=box');
 const old=app.fetchMessageList(params);const oldFailure=assert.rejects(old,/offline/);app.clearMessageListCache();const a=app.fetchMessageList(params,true);app.clearMessageListCache();const b=app.fetchMessageList(params,true);assert.equal(calls,1);
 pending[0].reject(Error('offline'));await oldFailure;await pause(0);assert.equal(calls,2);pending[1].resolve(Response.json({messages:[{id:'fresh'}]}));assert.deepEqual(await Promise.all([a,b]),Array(2).fill({messages:[{id:'fresh'}]}));assert.deepEqual(await app.fetchMessageList(params),{messages:[{id:'fresh'}]});assert.equal(calls,2);
});

test('an old list response cannot refill the cache or start a follow-up after switching accounts',async t=>{
 const pending=[];let calls=0;reset(t,()=>{calls++;return new Promise(resolve=>pending.push(resolve));});const params=new URLSearchParams('mailboxId=box');
 const old=app.fetchMessageList(params);app.clearMessageListCache();const waiter=app.fetchMessageList(params,true);app.clearMessageClientState();localStorage.setItem('mailflare-session-token','new-account');const current=app.fetchMessageList(params);assert.equal(calls,2);
 pending[1](Response.json({messages:[{id:'new-account'}]}));await current;pending[0](Response.json({messages:[{id:'old-account'}]}));await Promise.all([old,waiter]);assert.deepEqual(await app.fetchMessageList(params),{messages:[{id:'new-account'}]});assert.equal(calls,2);
});

test('a successful stale list result is followed by fresh data and never cached',async t=>{
 const pending=[];let calls=0;reset(t,()=>{calls++;return new Promise(resolve=>pending.push(resolve));});const params=new URLSearchParams('mailboxId=box');
 const old=app.fetchMessageList(params);app.clearMessageListCache();const fresh=app.fetchMessageList(params,true);pending[0](Response.json({messages:[{id:'stale'}]}));await old;await pause(0);assert.equal(calls,2);
 const second=app.fetchMessageList(params);assert.equal(calls,2);pending[1](Response.json({messages:[{id:'fresh'}]}));assert.deepEqual(await Promise.all([fresh,second]),Array(2).fill({messages:[{id:'fresh'}]}));
});
