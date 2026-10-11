import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','CustomEvent','Event'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const directory=mkdtempSync(join(process.cwd(),'node_modules','mailflare-badge-sync-'));after(()=>{rmSync(directory,{recursive:true,force:true});dom.window.close();});
writeFileSync(join(directory,'auth.mjs'),'export const AUTH_SESSION_CHANGED_EVENT="mailflare:auth-session-changed";export const authFetch=(url,init)=>globalThis.fetch(url,init);');
await build({entryPoints:['src/components/app-badge-sync.tsx'],outfile:join(directory,'component.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'@/lib/auth/client':join(directory,'auth.mjs')},logLevel:'silent'});
const {AppBadgeSync}=await import(pathToFileURL(join(directory,'component.mjs')).href);const React=await import('react');const {act}=React;const {createRoot}=await import('react-dom/client');

async function mount(t,fetch){
 const badges=[];navigator.setAppBadge=async n=>badges.push(n);navigator.clearAppBadge=async()=>badges.push(0);
 t.mock.method(globalThis,'fetch',fetch);
 document.body.innerHTML='<div id="root"></div>';const root=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(async()=>root.unmount());delete navigator.setAppBadge;delete navigator.clearAppBadge;});
 await act(async()=>root.render(React.createElement(AppBadgeSync)));
 return badges;
}
async function change(name='mailflare:messages-changed'){
 await act(async()=>{window.dispatchEvent(new Event(name));await new Promise(r=>setTimeout(r,180));});
}

test('foreground unread count updates after reading and clears on logout',async t=>{
 let unread=4,loggedOut=false;
 const badges=await mount(t,async()=>loggedOut?new Response(null,{status:401}):Response.json({unreadCount:unread}));
 assert.deepEqual(badges,[4]);unread=0;await change();assert.equal(badges.at(-1),0);
 unread=2;await change();assert.equal(badges.at(-1),2);loggedOut=true;await change('mailflare:auth-session-changed');assert.equal(badges.at(-1),0);
});

test('a stale unread response cannot restore a badge after a newer read event',async t=>{
 let resolve;let calls=0;
 const badges=await mount(t,()=>++calls===1?new Promise(r=>{resolve=r;}):Promise.resolve(Response.json({unreadCount:0})));
 await change();assert.deepEqual(badges,[0]);await act(async()=>resolve(Response.json({unreadCount:9})));assert.deepEqual(badges,[0]);
});

test('network errors keep the last known unread badge instead of clearing it',async t=>{
 let offline=false;const badges=await mount(t,async()=>{if(offline)throw new Error('Offline');return Response.json({unreadCount:5});});
 offline=true;await change();assert.deepEqual(badges,[5]);
});

test('browsers without the badge API do not make additional badge requests',async t=>{
 let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;return Response.json({unreadCount:1});});
 document.body.innerHTML='<div id="root"></div>';const root=createRoot(document.getElementById('root'));
 try{await act(async()=>root.render(React.createElement(AppBadgeSync)));await change();assert.equal(requests,0);}finally{await act(async()=>root.unmount());}
});
