import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','CustomEvent','Event','HTMLElement'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-refresh-tests-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
await build({stdin:{contents:`export {useMessages} from './src/hooks/use-messages';export {clearMessageClientState} from './src/hooks/utils';`,resolveDir:process.cwd(),loader:'ts'},outfile:join(dir,'entry.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const {useMessages,clearMessageClientState}=await import(pathToFileURL(join(dir,'entry.mjs')).href);
const React=await import('react');const {act}=React;const {createRoot}=await import('react-dom/client');
let root,state,renders;
function Harness(props){state=useMessages(props.folder??'inbox',props.mailbox??'box',props.filters,props.enabled??true);renders.push({ids:state.messages.map(m=>m.id),loading:state.isLoading,refreshing:state.isRefreshing,error:state.error,failure:state.failure});return React.createElement('div',null,state.messages.map(m=>m.id).join(','));}
const response=id=>Response.json({messages:[{id,direction:'inbound',read:false}],total:1,limit:25,offset:0});
async function mount(t,fetcher,props={}){clearMessageClientState();localStorage.clear();renders=[];document.body.innerHTML='<div id="root"></div>';t.mock.method(globalThis,'fetch',fetcher);root=createRoot(document.getElementById('root'));t.after(async()=>{await act(async()=>root.unmount());});await act(async()=>root.render(React.createElement(Harness,props)));}
const render=props=>act(async()=>root.render(React.createElement(Harness,props)));

test('cached category remount shows its messages immediately without a loading flash',async t=>{
 let calls=0;await mount(t,async()=>{calls++;return response('cached-inbox');});assert.equal(state.isLoading,false);await render({folder:'social'});assert.equal(calls,2);const start=renders.length;await render({folder:'inbox'});assert.deepEqual(renders[start].ids,['cached-inbox']);assert.equal(renders[start].loading,false);assert.equal(calls,2);
});

test('refresh bypasses caches, keeps visible messages and refreshes sidebar counts',async t=>{
 const calls=[];let resolve;await mount(t,async(url,init)=>{calls.push({url,cache:init.cache});return calls.length===1?response('old'):new Promise(r=>resolve=r);});let countEvents=0;const listener=()=>countEvents++;window.addEventListener('mailflare:message-counts-changed',listener);t.after(()=>window.removeEventListener('mailflare:message-counts-changed',listener));let pending;await act(async()=>{pending=state.refresh();});assert.equal(state.isRefreshing,true);assert.equal(state.isLoading,false);assert.equal(state.messages[0].id,'old');assert.equal(calls.at(-1).cache,'no-store');await act(async()=>{resolve(response('new'));await pending;});assert.equal(state.messages[0].id,'new');assert.equal(state.isRefreshing,false);assert.equal(countEvents,1);
});

test('a failed refresh preserves messages and retry clears the error',async t=>{
 let calls=0;await mount(t,async()=>{calls++;return calls===1?response('last-good'):calls===2?Response.json({error:'temporary failure'},{status:503}):response('recovered');});await act(async()=>state.refresh());assert.equal(state.messages[0].id,'last-good');assert.equal(state.error,true);assert.equal(state.isRefreshing,false);await act(async()=>state.refresh());assert.equal(state.messages[0].id,'recovered');assert.equal(state.error,false);
});

test('rapid mailbox changes never render the old mailbox while the new one is pending',async t=>{
 let resolve;await mount(t,async(url)=>String(url).includes('mailboxId=other')?new Promise(r=>resolve=r):response('private-box-message'));const start=renders.length;await render({mailbox:'other'});assert(renders.slice(start).every(r=>!r.ids.includes('private-box-message')));assert.equal(state.isLoading,true);await act(async()=>resolve(response('other-box-message')));assert.equal(state.messages[0].id,'other-box-message');
});

test('late responses from a previous category cannot replace the current category',async t=>{
 let resolve;await mount(t,async url=>String(url).includes('category=social')?new Promise(r=>resolve=r):response('inbox-message'));await render({folder:'social'});await render({folder:'inbox'});await act(async()=>resolve(response('late-social-message')));assert.equal(state.messages[0].id,'inbox-message');
});

test('an initially disabled hook loads correctly when enabled and handles network rejection',async t=>{
 // Every request is refused, the look into the cause included. The first refusal is retried before a notice appears.
 const real=window.setTimeout;window.setTimeout=(fn,ms,...rest)=>real(fn,Math.min(ms,10),...rest);t.after(()=>{window.setTimeout=real;});
 let calls=0;await mount(t,async url=>{if(String(url).startsWith('/api/messages?'))calls++;throw new Error('offline');},{enabled:false});assert.equal(calls,0);const start=renders.length;await render({enabled:true});assert(renders.slice(start).some(r=>r.loading));assert.equal(state.isLoading,true,'still loading while the first refusal is retried');assert.equal(state.error,false);assert.equal(calls,1);
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,60));});assert.equal(state.isLoading,false);assert.equal(state.error,true);assert.equal(state.failure,'offline');assert(calls>=2);
});

// The hook waits seconds between its own tries; here every wait is a few milliseconds.
function fastTimers(t){const real=window.setTimeout;window.setTimeout=(fn,ms,...rest)=>real(fn,Math.min(ms,10),...rest);t.after(()=>{window.setTimeout=real;});}
const settle=async(ms=80)=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
const announce=()=>act(async()=>{window.dispatchEvent(new Event('mailflare:messages-changed'));});
const isList=url=>String(url).startsWith('/api/messages?');
const offline=()=>Promise.reject(new TypeError('Failed to fetch'));

test('a refresh that fails once is tried again by itself and never shows a notice',async t=>{
 fastTimers(t);let lists=0,probes=0;
 await mount(t,async url=>{if(!isList(url)){probes++;return Response.json({user:{id:'owner'}});}lists++;return lists===1?response('last-good'):lists===2?offline():response('after-blip');});
 const start=renders.length;await announce();await settle();
 assert.equal(state.messages[0].id,'after-blip');assert.equal(lists,3,'one failed try, one successful retry');assert.equal(probes,1,'the failure was looked into once');
 assert(renders.slice(start).every(r=>!r.error&&r.failure===null),'no notice for a connection that dropped for a moment');
 assert(renders.slice(start).every(r=>r.ids.length===1),'the list stays on screen throughout');
});

test('a refresh that keeps failing shows why, keeps trying and clears the notice when it works again',async t=>{
 fastTimers(t);let lists=0,reachable=false,working=false;
 await mount(t,async url=>{if(!isList(url))return reachable?Response.json({user:{id:'owner'}}):offline();lists++;return lists===1?response('last-good'):working?response('back-again'):offline();});
 await announce();await settle();
 assert.equal(state.error,true);assert.equal(state.failure,'offline','nothing answers: no connection');assert.equal(state.messages[0].id,'last-good');
 const tries=lists;await settle();assert(lists>tries,'it keeps trying while the notice is shown');assert.equal(state.error,true);
 reachable=true;await settle();assert.equal(state.failure,'connection','the server answers, only the list request does not');
 working=true;await settle();assert.equal(state.error,false);assert.equal(state.failure,null);assert.equal(state.messages[0].id,'back-again');
 const after=lists;await settle();assert.equal(lists,after,'nothing is asked again once the list is back');
});

test('a login wall in front of the server is named at once and offers to reload instead of blaming the connection',async t=>{
 fastTimers(t);let lists=0;
 // An access gateway redirects every request to its login; unfollowed, that is an opaque redirect.
 await mount(t,async(url,init)=>{if(!isList(url)){assert.equal(init.redirect,'manual');return {type:'opaqueredirect',status:0,ok:false};}lists++;return lists===1?response('last-good'):offline();});
 await announce();await settle(40);
 assert.equal(state.error,true);assert.equal(state.failure,'sign-in');assert.equal(state.messages[0].id,'last-good');
});

test('a server error is silent once, then named; a refresh the reader asked for reports at once',async t=>{
 fastTimers(t);let lists=0,broken=true;
 let rendersAtRetry=null;
 await mount(t,async url=>{assert(isList(url),'a status needs no further question');lists++;if(lists===3)rendersAtRetry=renders.length;return lists===1?response('last-good'):broken?Response.json({error:'unavailable'},{status:503}):response('repaired');});
 const start=renders.length;await announce();await act(async()=>{await new Promise(resolve=>setTimeout(resolve,200));});
 assert(rendersAtRetry!==null,'the failed refresh was tried again');assert.equal(renders.slice(start,rendersAtRetry).some(r=>r.error),false,'no notice before the retry has failed too');
 assert.equal(state.error,true);assert.equal(state.failure,'server');
 broken=false;await settle();assert.equal(state.error,false);assert.equal(state.messages[0].id,'repaired');
 broken=true;await act(async()=>state.refresh());assert.equal(state.error,true,'pressing refresh gets an answer right away');assert.equal(state.failure,'server');
});

test('coming back online reads the list again without waiting for the next try',async t=>{
 fastTimers(t);let lists=0;
 await mount(t,async url=>{if(!isList(url))return offline();lists++;return response('list-'+lists);});
 await act(async()=>{window.dispatchEvent(new Event('online'));});await settle(30);
 assert.equal(lists,2);assert.equal(state.messages[0].id,'list-2');
});

test('the notice stays while the window regains focus or the minute tick asks again, until a read succeeds',async t=>{
 fastTimers(t);let lists=0,working=false,release=null;
 await mount(t,async url=>{if(!isList(url))return offline();lists++;if(lists===1)return response('last-good');if(working)return response('back-again');if(release)return new Promise((_,reject)=>{const fail=release;release=null;fail(()=>reject(new TypeError('Failed to fetch')));});return offline();});
 await announce();await settle();assert.equal(state.error,true);assert.equal(state.failure,'offline');
 // The next read is held open: while it is under way the notice must still be there.
 let fail;release=f=>{fail=f;};const start=renders.length;await announce();await act(async()=>{await new Promise(resolve=>setTimeout(resolve,200));});
 assert(fail,'the read set off by the announcement is under way');assert.equal(renders.slice(start).every(r=>r.error&&r.failure==='offline'),true,'no render without the notice: '+JSON.stringify(renders.slice(start)));
 await act(async()=>{fail();});await settle();assert.equal(state.error,true);
 working=true;await announce();await settle();assert.equal(state.error,false);assert.equal(state.failure,null);assert.equal(state.messages[0].id,'back-again');
});

test('an expired sign-in is not asked about again and again; only the reader or a new sign-in reads the list again',async t=>{
 fastTimers(t);let lists=0,signedIn=false;
 await mount(t,async url=>{if(!isList(url))return signedIn?Response.json({user:{id:'owner'}}):{type:'opaqueredirect',status:0,ok:false};lists++;return lists===1?response('last-good'):signedIn?response('signed-in-again'):offline();});
 await announce();await settle(40);assert.equal(state.failure,'sign-in');
 const asked=lists;await settle(200);assert.equal(lists,asked,'no further tries by itself');assert.equal(state.error,true);assert.equal(state.failure,'sign-in');
 // The window regaining focus, the minute tick and the connection coming back all announce a change.
 await announce();await act(async()=>{window.dispatchEvent(new Event('online'));});await settle(200);
 assert.equal(lists,asked,'background announcements do not ask either');assert.equal(state.failure,'sign-in','the notice with its reload button stays');
 await act(async()=>state.refresh());assert.equal(lists,asked+1,'the reader\'s own refresh does ask');assert.equal(state.failure,'sign-in');
 signedIn=true;await act(async()=>{window.dispatchEvent(new Event('mailflare:auth-session-changed'));});await settle();
 assert.equal(state.error,false);assert.equal(state.messages[0].id,'signed-in-again','a new sign-in reads the list at once');
});
