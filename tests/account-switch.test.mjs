import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','navigator','localStorage','HTMLElement','MutationObserver','CustomEvent','Event'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-account-switch-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
writeFileSync(join(dir,'chrome.mjs'),`export const BrandingProvider=({children})=>children;
export const PwaServiceWorker=()=>null;export const AppBadgeSync=()=>null;export const ThemeSync=()=>null;export const NewMessagePopup=()=>null;
export const useMessagePolling=()=>({notification:null});`);
await build({stdin:{contents:`
export {useMessages} from './src/hooks/use-messages.ts';
export {useMessageCounts} from './src/hooks/use-message-counts.ts';
export {Providers} from './src/components/providers.tsx';
export {MailboxProvider,useSelectedMailbox} from './src/components/mailbox-provider.tsx';
export {setClientSessionToken,getClientSessionToken,authFetch} from './src/lib/auth/client.ts';
export {switchBrowserAccount} from './src/lib/auth/accounts-client.ts';
export {fetchCurrentUser,clearCurrentUserCache,useCurrentUser} from './src/hooks/use-current-user.ts';
export {fetchCachedMessageDetail,getCachedMessageDetail,clearMessageDetailCache,preloadMessageDetail} from './src/lib/messages/detail-cache.ts';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',alias:Object.fromEntries(['@/components/branding-provider','@/components/pwa-service-worker','@/components/app-badge-sync','@/components/theme-sync','@/components/new-message-popup','@/hooks/use-message-polling'].map(key=>[key,join(dir,'chrome.mjs')])),logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const mailbox=id=>({id,domainId:'domain',localPart:id,hostname:'example.test',type:'personal',permission:'full_access',isPrimary:true});

test('switching a browser account refreshes mailbox, identity and local UI without reloading',async t=>{
 localStorage.clear();app.clearCurrentUserCache();app.setClientSessionToken('old');
 let mounts=0,unmounts=0;const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{const token=new Headers(init?.headers).get('Authorization');calls.push([url,token]);
  if(url==='/api/auth/switch')return Response.json({token:'new'});
  const id=token==='Bearer new'?'new':'old';
  if(url.startsWith('/api/messages/counts'))return Response.json({counts:{folders:{inbox:{total:1,unread:id==='new'?7:3}},customFolders:{},mailboxes:[]}});
  if(url.startsWith('/api/messages?'))return Response.json({messages:[{id:id+'-message',direction:'inbound',read:false}],total:1});
  return Response.json(url==='/api/mailboxes'?{mailboxes:[mailbox(id)]}:{user:{id,name:id}});
 });
 function Screen(){const selected=app.useSelectedMailbox(),user=app.useCurrentUser();const listing=app.useMessages('inbox',selected.selectedMailbox?.id,undefined,!selected.isLoading),counter=app.useMessageCounts(selected.selectedMailbox?.id,!selected.isLoading);const [draft,setDraft]=React.useState('');React.useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return React.createElement('div',null,React.createElement('output',null,selected.isLoading?'loading':selected.selectedMailbox?.id+' / '+user?.id+' / '+listing.messages[0]?.id+' / '+counter.counts.folders.inbox.unread),React.createElement('button',{onClick:()=>setDraft('old-account-draft')},draft||'empty'));}
 document.body.innerHTML='<div id="root"></div>';const root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 await act(async()=>root.render(React.createElement(app.Providers,null,React.createElement(app.MailboxProvider,null,React.createElement(Screen)))));
 assert.equal(document.querySelector('output').textContent,'old / old / old-message / 3');
 await act(async()=>document.querySelector('button').click());assert.equal(document.querySelector('button').textContent,'old-account-draft');
 await act(async()=>{assert.equal(await app.switchBrowserAccount('new'),null);});
 assert.equal(document.querySelector('output').textContent,'new / new / new-message / 7');
 assert.equal(document.querySelector('button').textContent,'empty');
 assert.equal(localStorage.getItem('selected-mailbox-id'),'new');assert.equal(mounts,2);assert.equal(unmounts,1);
 assert(calls.some(([url,token])=>url==='/api/mailboxes'&&token==='Bearer new'));
});

test('late mailbox responses from an old account cannot replace the new selected mailbox',async t=>{
 localStorage.clear();app.setClientSessionToken('slow');const pending=deferred();
 t.mock.method(globalThis,'fetch',async(url,init)=>new Headers(init.headers).get('Authorization')==='Bearer slow'?pending.promise:Response.json({mailboxes:[mailbox('fast')]}));
 function Screen(){const {selectedMailbox,isLoading}=app.useSelectedMailbox();return React.createElement('output',null,isLoading?'loading':selectedMailbox?.id);}
 document.body.innerHTML='<div id="root"></div>';const root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 await act(async()=>root.render(React.createElement(app.Providers,null,React.createElement(app.MailboxProvider,null,React.createElement(Screen)))));
 assert.equal(document.querySelector('output').textContent,'loading');
 await act(async()=>app.setClientSessionToken('fast'));assert.equal(document.querySelector('output').textContent,'fast');
 await act(async()=>pending.resolve(Response.json({mailboxes:[mailbox('slow')]})));assert.equal(document.querySelector('output').textContent,'fast');
});

test('stale user and message requests cannot refill cleared caches or erase newer requests',async t=>{
 app.clearCurrentUserCache();app.clearMessageDetailCache();app.setClientSessionToken('old');
 const oldUser=deferred(),newUser=deferred(),oldDetail=deferred(),newDetail=deferred();let phase='old',userCalls=0,detailCalls=0;
 t.mock.method(globalThis,'fetch',async url=>{if(url==='/api/auth/me'){userCalls++;return phase==='old'?oldUser.promise:newUser.promise;}detailCalls++;return phase==='old'?oldDetail.promise:newDetail.promise;});
 const u1=app.fetchCurrentUser(),d1=app.fetchCachedMessageDetail('same');
 app.setClientSessionToken('new');app.clearCurrentUserCache();app.clearMessageDetailCache();phase='new';
 const u2=app.fetchCurrentUser(),d2=app.fetchCachedMessageDetail('same');
 oldUser.resolve(Response.json({user:{id:'old'}}));oldDetail.resolve(Response.json({message:{id:'same',subject:'old'}}));await Promise.all([u1,d1]);
 assert.equal(app.getCachedMessageDetail('same'),undefined);const u3=app.fetchCurrentUser(),d3=app.fetchCachedMessageDetail('same');assert.equal(userCalls,2);assert.equal(detailCalls,2);
 newUser.resolve(Response.json({user:{id:'new'}}));newDetail.resolve(Response.json({message:{id:'same',subject:'new'}}));
 await Promise.all([u2,u3,d2,d3]);assert.equal((await app.fetchCurrentUser()).id,'new');assert.equal(app.getCachedMessageDetail('same').message.subject,'new');
});

test('a delayed 401 from a previous session cannot log out the new account',async t=>{
 app.setClientSessionToken('old');const pending=deferred();t.mock.method(globalThis,'fetch',()=>pending.promise);
 const request=app.authFetch('/api/messages');app.setClientSessionToken('new');pending.resolve(new Response(null,{status:401}));
 assert.equal((await request).status,401);assert.equal(app.getClientSessionToken(),'new');
});


test('a rejected switch keeps the active account session',async t=>{
 app.setClientSessionToken('active');t.mock.method(globalThis,'fetch',async()=>Response.json({error:'Account session expired'},{status:401}));
 assert.equal(await app.switchBrowserAccount('expired'),'Account session expired');assert.equal(app.getClientSessionToken(),'active');
});


test('authenticated fetch never sends the session to a different origin',async t=>{
 app.setClientSessionToken('private-session');let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({ok:true});});
 for(const target of ['https://external.test/collect','//external.test/collect',new URL('https://external.test/'),new Request('https://external.test/')]) await assert.rejects(app.authFetch(target),/Mailflare origin/);
 assert.equal(calls,0);assert.equal(app.getClientSessionToken(),'private-session');await app.authFetch('/api/auth/me');assert.equal(calls,1);
});


test('temporary message failures never poison the detail cache and the next attempt can succeed',async t=>{
 app.clearMessageDetailCache();app.setClientSessionToken('active');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1)return Response.json({error:'Unavailable'},{status:503});if(calls===2)throw Error('offline');if(calls===3)return Response.json({error:'invalid response'});return Response.json({message:{id:'retry'},body:{textBody:'Recovered',htmlBody:null}});});
 for(let i=0;i<2;i++){await assert.rejects(app.fetchCachedMessageDetail('retry'));assert.equal(app.getCachedMessageDetail('retry'),undefined);}
 assert.equal((await app.fetchCachedMessageDetail('retry')).body.textBody,'Recovered');assert.equal(calls,4);
});

test('empty server failures and a connection failure recover inside the one shared reader request',async t=>{
 app.clearMessageDetailCache();app.setClientSessionToken('active');let calls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;assert.equal(init.cache,'no-store');if(calls===1)return new Response(null,{status:500});if(calls===2)throw new TypeError('Failed to fetch');return Response.json({message:{id:'recover'},body:{textBody:'Recovered'}});});
 app.preloadMessageDetail({id:'recover'});const a=app.fetchCachedMessageDetail('recover'),b=app.fetchCachedMessageDetail('recover');
 assert.equal((await a).body.textBody,'Recovered');assert.equal((await b).body.textBody,'Recovered');assert.equal(calls,3);assert.equal(app.getCachedMessageDetail('recover').body.textBody,'Recovered');
});

test('persistent server failures stop after three attempts and remain manually retryable',async t=>{
 app.clearMessageDetailCache();let calls=0;let fail=true;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return fail?new Response(null,{status:503}):Response.json({message:{id:'persistent'},body:{textBody:'Ready'}});});
 await assert.rejects(app.fetchCachedMessageDetail('persistent'));assert.equal(calls,3);assert.equal(app.getCachedMessageDetail('persistent'),undefined);
 fail=false;assert.equal((await app.fetchCachedMessageDetail('persistent')).body.textBody,'Ready');assert.equal(calls,4);
});

test('permanent errors, invalid responses and explicit aborts are not retried',async t=>{
 for(const value of [new Response(null,{status:403}),new Response(null,{status:404}),new Response('invalid json'),Response.json({error:'Not a message'}),new DOMException('Cancelled','AbortError')]){
  app.clearMessageDetailCache();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;if(value instanceof Error)throw value;return value;});
  await assert.rejects(app.fetchCachedMessageDetail('permanent'));assert.equal(calls,1);assert.equal(app.getCachedMessageDetail('permanent'),undefined);
 }
});

test('an account change during retry backoff never sends the old message request with the new session',async t=>{
 app.clearMessageDetailCache();app.setClientSessionToken('old');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:500});});
 const pending=app.fetchCachedMessageDetail('old-private');const rejected=assert.rejects(pending,{name:'AbortError'});
 await new Promise(resolve=>setTimeout(resolve,30));app.setClientSessionToken('new');await rejected;
 assert.equal(calls,1);assert.equal(app.getCachedMessageDetail('old-private'),undefined);
});

test('intent, click and reader share one pending detail request without downloading all messages',async t=>{
 app.clearMessageDetailCache();let calls=0;const pending=deferred();t.mock.method(globalThis,'fetch',()=>{calls++;return pending.promise;});
 app.preloadMessageDetail({id:'chosen'});app.preloadMessageDetail({id:'chosen'});const reader=app.fetchCachedMessageDetail('chosen');assert.equal(calls,1);assert.equal(app.getCachedMessageDetail('other'),undefined);
 pending.resolve(Response.json({message:{id:'chosen'},body:{textBody:'Content',htmlBody:null}}));assert.equal((await reader).body.textBody,'Content');assert.equal(calls,1);
});
