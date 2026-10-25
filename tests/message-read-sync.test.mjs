import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','sessionStorage','CustomEvent','Event','HTMLElement'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let visibility='visible';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-read-sync-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
writeFileSync(join(dir,'mailbox.ts'),`export const useSelectedMailbox=()=>({selectedMailbox:{id:'box'},isLoading:false});`);
writeFileSync(join(dir,'navigation.ts'),`export const useRouter=()=>({push:path=>{window.__navigated=path}});`);
await build({stdin:{contents:`
 export {MailSearchProvider} from './src/components/mail-search/mail-search-context';
 export {useMessageCounts} from './src/hooks/use-message-counts';
 export {useMessagePolling} from './src/hooks/use-message-polling';
 export {clearMessageClientState,fetchMessageCounts} from './src/hooks/utils';
 export {runBulkMessageAction} from './src/components/messages/utils';
 export {MessageDetailNavigationProvider,MessageDetailNavigation} from './src/components/messages/message-detail-navigation';
 export {getMessageDetailNavigationState} from './src/components/messages/message-detail-navigation-utils';
`,resolveDir:process.cwd(),loader:'ts'},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'@/components/mailbox-provider':join(dir,'mailbox.ts'),'next/navigation':join(dir,'navigation.ts')},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const delay=()=>new Promise(resolve=>setTimeout(resolve,180));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const counts=unread=>({folders:{inbox:{total:7,unread},all:{total:9,unread:unread+2}},customFolders:{work:{total:7,unread}},mailboxes:[{mailboxId:'box',total:9,unread:unread+2,inbox:7}]});
const entries=Array.from({length:7},(_,i)=>({id:'mail-'+i,unread:true}));
let counter,root;
function Screen({mailbox='box',navigation=false}) {
 counter=app.useMessageCounts(mailbox);
 return React.createElement(React.Fragment,null,
  React.createElement('output',null,counter.counts.folders.inbox.unread),
  navigation&&React.createElement(app.MessageDetailNavigationProvider,{config:{folder:'inbox',hrefPrefix:'/inbox'}},React.createElement(app.MessageDetailNavigation,{messageId:'mail-2'})));
}
async function mount(t,fetcher,props={}){
 visibility='visible';app.clearMessageClientState();localStorage.clear();sessionStorage.clear();document.body.innerHTML='<div id="root"></div>';
 t.mock.method(globalThis,'fetch',fetcher);root=createRoot(document.getElementById('root'));
 t.after(async()=>act(async()=>root.unmount()));
 await act(async()=>root.render(React.createElement(app.MailSearchProvider,null,React.createElement(Screen,props))));
}
const countResponse=unread=>Response.json({counts:counts(unread)});

test('reader position and arrows match chronological list order, even when the current email is already read',()=>{
 const rows=[{id:'newest',unread:false},{id:'middle',unread:true},{id:'oldest',unread:false}];
 assert.deepEqual(app.getMessageDetailNavigationState(rows,'newest'),{previousId:null,nextId:'middle',position:1,total:3});
 assert.deepEqual(app.getMessageDetailNavigationState(rows,'oldest'),{previousId:'middle',nextId:null,position:3,total:3});
 assert.deepEqual(app.getMessageDetailNavigationState(rows.map(row=>({...row,unread:false})),'newest'),app.getMessageDetailNavigationState(rows,'newest'));
 assert.deepEqual(app.getMessageDetailNavigationState(rows,'removed'),{previousId:null,nextId:null,position:0,total:3});
});

test('quiet read actions refresh all counters without requiring a browser reload or list refresh',async t=>{
 let unread=7,listEvents=0;const requested=[];
 const changed=()=>listEvents++;window.addEventListener('mailflare:messages-changed',changed);t.after(()=>window.removeEventListener('mailflare:messages-changed',changed));
 await mount(t,async(url,init)=>{
  requested.push([String(url),init?.cache]);
  if(url==='/api/messages/bulk'){unread=JSON.parse(init.body).action==='unread'?7:0;return Response.json({ok:true});}
  return countResponse(unread);
 });
 assert.equal(counter.counts.folders.inbox.unread,7);
 await act(async()=>{await app.runBulkMessageAction(entries.map(row=>row.id),'read',false);await delay();});
 assert.equal(counter.counts.folders.inbox.unread,0);
 assert.equal(counter.counts.folders.all.unread,2);assert.equal(counter.counts.customFolders.work.unread,0);assert.equal(counter.counts.mailboxes[0].unread,2);
 assert.equal(listEvents,0,'quiet reads do not reset the list');assert.equal(requested.at(-1)[1],'no-store');
 await act(async()=>{await app.runBulkMessageAction(entries.map(row=>row.id),'unread',false);await delay();});
 assert.equal(counter.counts.folders.inbox.unread,7);assert.equal(counter.counts.folders.all.unread,9);assert.equal(listEvents,0);
});

test('reading while no counters are mounted invalidates their cached values; failures retain the last known count',async t=>{
 app.clearMessageClientState();localStorage.clear();let unread=7,fail=false;
 t.mock.method(globalThis,'fetch',async url=>{if(url==='/api/messages/bulk'){if(fail)return new Response(null,{status:503});unread=0;return Response.json({ok:true});}return countResponse(unread);});
 assert.equal((await app.fetchMessageCounts('box')).folders.inbox.unread,7);
 fail=true;await assert.rejects(()=>app.runBulkMessageAction(['mail-0'],'read',false));
 assert.equal((await app.fetchMessageCounts('box')).folders.inbox.unread,7);
 fail=false;await app.runBulkMessageAction(entries.map(row=>row.id),'read',false);
 assert.equal((await app.fetchMessageCounts('box')).folders.inbox.unread,0);
});

test('a late counts request cannot overwrite an optimistic read during the refresh debounce',async t=>{
 const stale=deferred();let requests=0,unread=7;
 await mount(t,async url=>{if(url==='/api/messages/bulk'){unread=0;return Response.json({ok:true});}requests++;return requests===2?stale.promise:countResponse(unread);});
 await act(async()=>{window.dispatchEvent(new Event('focus'));await delay();});
 assert.equal(requests,2);
 await act(async()=>window.dispatchEvent(new CustomEvent('mailflare:message-counts-delta',{detail:{mailboxId:'box',inboxUnreadDelta:-1}})));
 assert.equal(counter.counts.folders.inbox.unread,6);
 await act(async()=>stale.resolve(countResponse(7)));
 assert.equal(counter.counts.folders.inbox.unread,6,'the old response must not restore seven');
 await act(async()=>{await app.runBulkMessageAction(entries.map(row=>row.id),'read',false);await delay();});
 assert.equal(counter.counts.folders.inbox.unread,0);
});

test('counts and reader navigation reconcile on returning to a backgrounded app',async t=>{
 let unread=7,rows=entries;
 await mount(t,async url=>url.startsWith('/api/messages/navigation')?Response.json({messages:rows}):countResponse(unread),{navigation:true});
 assert.equal(document.querySelector('[aria-live]').textContent,'3 of 7');
 assert(!document.body.textContent.includes('0 of 7 unread'));
 visibility='hidden';unread=0;rows=entries.slice(1).map(row=>({...row,unread:false}));
 await act(async()=>{window.dispatchEvent(new Event('mailflare:message-counts-changed'));await delay();});
 assert.equal(counter.counts.folders.inbox.unread,7);
 visibility='visible';
 await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));await delay();});
 assert.equal(counter.counts.folders.inbox.unread,0);assert.equal(document.querySelector('[aria-live]').textContent,'2 of 6');
 assert.equal(document.querySelector('button[aria-label="Newer email"]').disabled,false);
 await act(async()=>document.querySelector('button[aria-label="Newer email"]').click());assert.equal(window.__navigated,'/inbox/mail-1');
});

test('message changes update reader membership and delayed navigation cannot restore a deleted email',async t=>{
 let rows=entries,navigationRequests=0;const stale=deferred();
 await mount(t,async url=>{if(url.startsWith('/api/messages/navigation')){navigationRequests++;return navigationRequests===2?stale.promise:Response.json({messages:rows});}return countResponse(0);},{navigation:true});
 await act(async()=>{window.dispatchEvent(new Event('mailflare:messages-changed'));await delay();});
 rows=entries.slice(2);
 await act(async()=>{window.dispatchEvent(new Event('mailflare:messages-changed'));await delay();});
 assert.equal(document.querySelector('[aria-live]').textContent,'1 of 5');
 await act(async()=>stale.resolve(Response.json({messages:entries})));
 assert.equal(document.querySelector('[aria-live]').textContent,'1 of 5');assert.equal(document.querySelector('button[aria-label="Newer email"]').disabled,true);
});

test('switching mailboxes never displays the old count and deltas from another mailbox are ignored',async t=>{
 const pending=deferred();await mount(t,async url=>String(url).includes('mailboxId=other')?pending.promise:countResponse(7));
 await act(async()=>root.render(React.createElement(app.MailSearchProvider,null,React.createElement(Screen,{mailbox:'other'}))));
 assert.equal(counter.counts.folders.inbox.unread,0,'old mailbox counts are not rendered while loading');
 await act(async()=>pending.resolve(countResponse(0)));
 await act(async()=>window.dispatchEvent(new CustomEvent('mailflare:message-counts-delta',{detail:{mailboxId:'box',inboxUnreadDelta:1}})));
 assert.equal(counter.counts.folders.inbox.unread,0);
});

test('quiet counter changes are forwarded to other browser tabs without a refresh loop',async t=>{
 localStorage.clear();const messages=[];let closed=false;
 const original=globalThis.BroadcastChannel;
 globalThis.BroadcastChannel=class {postMessage(message){messages.push(message);}close(){closed=true;}};
 function Polling(){app.useMessagePolling();return null;}
 document.body.innerHTML='<div id="root"></div>';const pollingRoot=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(async()=>pollingRoot.unmount());globalThis.BroadcastChannel=original;});
 await act(async()=>pollingRoot.render(React.createElement(Polling)));
 messages.length=0;
 window.dispatchEvent(new Event('mailflare:message-counts-changed'));
 assert.deepEqual(messages,[{type:'refresh'}]);
 window.dispatchEvent(new CustomEvent('mailflare:messages-changed',{detail:{realtime:true}}));
 assert.equal(messages.length,1,'received realtime updates are not rebroadcast');
 await act(async()=>pollingRoot.unmount());assert.equal(closed,true);
 window.dispatchEvent(new Event('mailflare:message-counts-changed'));assert.equal(messages.length,1,'unmount removes the forwarding listener');
});
