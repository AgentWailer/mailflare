import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test'});
for(const key of ['window','document','localStorage','CustomEvent','Event'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-read-all-client-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
await build({stdin:{contents:`export * from './src/components/messages/read-all-task';export {setClientSessionToken} from './src/lib/auth/client';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
let current,root;
const scope={folder:'inbox',mailboxId:'box',query:'from:sender@example.test',unreadOnly:false,title:'Posteingang'};
const data=(ids,done=false)=>Response.json({messageIds:ids,done,snapshot:999,after:200,actorId:'owner',mailboxIds:['box'],total:3});
const wait=async predicate=>{for(let i=0;i<50&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});assert(predicate(),'background task reached expected state');};
function Screen(){current=app.useReadAllTask();return React.createElement('output',null,current?.status??'idle');}
async function mount(t,fetcher){localStorage.clear();app.dismissReadAllTask();document.body.innerHTML='<div id="root"></div>';t.mock.method(globalThis,'fetch',fetcher);root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Screen)));t.after(async()=>{await act(async()=>root.unmount());app.dismissReadAllTask();});}

test('read-all advances bounded chunks asynchronously, deduplicates clicks and preserves the captured scope',async t=>{
 const requests=[];let release;
 await mount(t,async(_url,init)=>{requests.push(JSON.parse(init.body));if(requests.length===1)await new Promise(resolve=>release=resolve);return data(requests.length===1?['one','two']:['three'],requests.length>1);});
 await act(async()=>{app.startReadAllTask(scope);app.startReadAllTask({...scope,folder:'spam'});});assert.equal(current.status,'running');assert.equal(requests.length,1);
 // Other UI work can proceed while the request is outstanding.
 document.body.dataset.interactive='yes';assert.equal(document.body.dataset.interactive,'yes');
 await act(async()=>release());await wait(()=>current?.status==='done');assert.equal(current.processed,3);assert.equal(requests.length,2);
 assert.equal(requests[0].q,scope.query);assert.equal(requests[1].folder,'inbox');assert.equal(requests[1].snapshot,999);assert.equal(requests[1].after,200);assert.equal(requests[1].actorId,'owner');assert.deepEqual(requests[1].mailboxIds,['box']);
});

test('navigation/unmount does not abandon chunks and a new subscriber observes completion',async t=>{
 let calls=0,release;
 await mount(t,async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return data(['mail-'+calls],calls===2);});
 await act(async()=>app.startReadAllTask(scope));await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Screen)));
 assert.equal(current.status,'running');await act(async()=>release());await wait(()=>current?.status==='done');assert.equal(calls,2);
});

test('failure retains progress and retry reuses the snapshot instead of marking newly arriving messages',async t=>{
 let calls=0;const requests=[];
 await mount(t,async(_url,init)=>{calls++;requests.push(JSON.parse(init.body));return calls===2?Response.json({error:'offline'},{status:503}):data(['mail-'+calls],calls===3);});
 await act(async()=>app.startReadAllTask(scope));await wait(()=>current?.status==='failed');assert.equal(current.processed,1);
 await act(async()=>app.retryReadAllTask());await wait(()=>current?.status==='done');assert.equal(current.processed,2);assert.equal(requests[1].snapshot,requests[2].snapshot);
});

test('account switch stops future chunks and ignores the old response',async t=>{
 let release,calls=0;
 await mount(t,async()=>{calls++;await new Promise(resolve=>release=resolve);return data(['old-account-mail']);});
 await act(async()=>app.startReadAllTask(scope));await act(async()=>app.setClientSessionToken('new-session'));await act(async()=>release());await wait(()=>current===null);assert.equal(calls,1);
});
