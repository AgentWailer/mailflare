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
await build({stdin:{contents:`export {NavItem} from './src/components/components-nav';export {LoadingTransition} from './src/components/loading-transition';export {usePageLoading} from './src/components/page-loading';export {fetchMessageCounts,clearMessageCountsCache,clearMessageClientState} from './src/hooks/utils';`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/navigation':navigation,'next/link':link,'@/components/sidebar-state':sidebar,'@/components/mailbox-provider':mailbox,'@/components/branding-provider':branding},plugins:[{name:'relative-fixture-contexts',setup(build){const mocks={'./sidebar-state':sidebar,'./mailbox-provider':mailbox,'./compose/compose-context':compose};build.onResolve({filter:/^\.(\/sidebar-state|\/mailbox-provider|\/compose\/compose-context)$/},args=>({path:mocks[args.path]}));}}],logLevel:'silent'});
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
