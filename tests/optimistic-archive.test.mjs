import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test'});
for(const key of ['window','document','localStorage','CustomEvent','Event','HTMLElement'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-archive-tests-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
await build({stdin:{contents:`export {useOptimisticArchive} from './src/components/messages/use-optimistic-archive';`,resolveDir:process.cwd(),loader:'ts'},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const {useOptimisticArchive}=await import(pathToFileURL(join(dir,'app.mjs')).href);
const React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const one={id:'one',threadMessageIds:['one','older']},two={id:'two'},three={id:'three'};
let root,state,requests;
function Harness({messages,total,scope}){state=useOptimisticArchive(messages,total,scope);return React.createElement('div',null,state.messages.map(m=>m.id).join(','));}
async function mount(t,messages=[one,two,three],total=3,scope='inbox'){
 document.body.innerHTML='<div id="root"></div>';localStorage.clear();requests=[];
 t.mock.method(globalThis,'fetch',(url,init)=>new Promise((resolve,reject)=>requests.push({url,payload:JSON.parse(init.body),resolve,reject})));
 root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 await act(async()=>root.render(React.createElement(Harness,{messages,total,scope})));
}
const render=(messages,total,scope='inbox')=>act(async()=>root.render(React.createElement(Harness,{messages,total,scope})));
const ids=()=>state.messages.map(m=>m.id);
async function start(message){let promise;await act(async()=>{promise=state.archiveRow(message);});return {promise};}

test('archive disappears immediately before the server answers and includes the whole represented conversation',async t=>{
 await mount(t,[one],1);const {promise}=await start(one);assert.deepEqual(ids(),[]);assert.equal(state.total,0);assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/messages/bulk');assert.deepEqual(requests[0].payload,{messageIds:['one','older'],action:'archive'});
 await act(async()=>{requests[0].resolve(Response.json({ok:true}));await promise;});assert.deepEqual(ids(),[],'a successful stale source does not reintroduce the row');
 await render([],0);assert.equal(state.total,0,'a refreshed count is not decremented twice');
});

test('a stale refresh cannot reintroduce an archive while its save is pending',async t=>{
 await mount(t);const {promise}=await start(one);await render([{...one,read:true},two,three],3);assert.deepEqual(ids(),['two','three']);
 await act(async()=>{requests[0].resolve(Response.json({ok:true}));await promise;});await render([two,three],2);assert.deepEqual(ids(),['two','three']);assert.equal(state.total,2);
});

test('a failed concurrent archive restores only that row and preserves other changes',async t=>{
 await mount(t);const a=await start(one),b=await start(two);const failed=assert.rejects(b.promise);assert.deepEqual(ids(),['three']);
 await render([one,{...two,read:true},{...three,starred:true}],3);
 await act(async()=>{requests[0].resolve(Response.json({ok:true}));await a.promise;requests[1].resolve(Response.json({error:'failed'},{status:503}));await failed;});
 assert.deepEqual(ids(),['two','three']);assert.equal(state.messages[0].read,true);assert.equal(state.messages[1].starred,true);assert.equal(state.archiveFailed,true);assert.equal(state.total,2);
});

test('a late failure from another mailbox cannot affect the current list or error state',async t=>{
 await mount(t,[one],1,'box/inbox');const {promise}=await start(one);const failed=assert.rejects(promise);await render([one],1,'other/inbox');assert.deepEqual(ids(),['one']);
 await act(async()=>{requests[0].reject(Error('offline'));await failed;});assert.deepEqual(ids(),['one']);assert.equal(state.archiveFailed,false);
});

test('an old operation cannot undo a new archive of the same row after navigating back',async t=>{
 await mount(t,[one],1,'box/inbox');const old=await start(one),failed=assert.rejects(old.promise);await render([one],1,'other/inbox');await render([one],1,'box/inbox');const current=await start(one);
 await act(async()=>{requests[0].reject(Error('offline'));await failed;});assert.deepEqual(ids(),[]);assert.equal(state.archiveFailed,false);
 await act(async()=>{requests[1].resolve(Response.json({ok:true}));await current.promise;});assert.deepEqual(ids(),[]);
});
