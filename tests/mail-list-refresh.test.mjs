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
function Harness(props){state=useMessages(props.folder??'inbox',props.mailbox??'box',props.filters,props.enabled??true);renders.push({ids:state.messages.map(m=>m.id),loading:state.isLoading,refreshing:state.isRefreshing,error:state.error});return React.createElement('div',null,state.messages.map(m=>m.id).join(','));}
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
 let calls=0;await mount(t,async()=>{calls++;throw new Error('offline');},{enabled:false});assert.equal(calls,0);const start=renders.length;await render({enabled:true});assert(renders.slice(start).some(r=>r.loading));assert.equal(state.isLoading,false);assert.equal(state.error,true);assert.equal(calls,1);
});
