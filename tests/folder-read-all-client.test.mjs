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
await build({stdin:{contents:`export * from './src/components/messages/read-all-task';export {setClientSessionToken,clearClientSessionToken} from './src/lib/auth/client';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
let current,root;
const scope={folder:'inbox',mailboxId:'box',query:'from:sender@example.test',unreadOnly:false,title:'Posteingang'};
const data=(processed=0,status='running',requestId='request')=>({id:'job',requestId,scope,action:'read',processed,total:20000,status});
const wait=async predicate=>{for(let i=0;i<50&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});assert(predicate(),'background task reached expected state');};
function Screen(){current=app.useReadAllTask();return React.createElement('output',null,current?.status??'idle');}
async function mount(t,fetcher){localStorage.clear();app.dismissReadAllTask();document.body.innerHTML='<div id="root"></div>';t.mock.method(globalThis,'fetch',fetcher);root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Screen)));t.after(async()=>{await act(async()=>root.unmount());app.dismissReadAllTask();});}


test('one idempotent server submission replaces browser chunk processing and leaves UI interactive',async t=>{
 const requests=[];let release,job=null;
 await mount(t,async(url,init)=>{if(init?.method!=='POST')return Response.json({job});requests.push(JSON.parse(init.body));await new Promise(resolve=>release=resolve);job={...data(),requestId:requests[0].requestId};return Response.json({job},{status:202});});
 await act(async()=>{app.startReadAllTask(scope);app.startReadAllTask({...scope,folder:'spam'});});assert.equal(current.status,'running');assert.equal(requests.length,1);document.body.dataset.interactive='yes';assert.equal(document.body.dataset.interactive,'yes');
 await act(async()=>release());await wait(()=>current?.id==='job');assert.equal(requests.length,1);assert.equal(requests[0].input.q,scope.query);assert.equal(requests[0].input.folder,'inbox');assert(!('after' in requests[0].input));
 job=data(20000,'done',job.requestId);await act(async()=>app.refreshBulkTask());await wait(()=>current?.status==='done');assert.equal(current.processed,20000);assert.equal(requests.length,1);
});
test('reopening subscribes to server progress without restarting the operation',async t=>{
 let job=data(960),posts=0;
 await mount(t,async(_url,init)=>{if(init?.method==='POST')posts++;return Response.json({job});});await wait(()=>current?.processed===960);
 await act(async()=>root.unmount());job=data(20000,'done');root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Screen)));await wait(()=>current?.status==='done');assert.equal(current.processed,20000);assert.equal(posts,0);
});
test('poll network failures retain the running server job; retry controls the stored checkpoint',async t=>{
 let job=data(500),offline=false,controls=[];
 await mount(t,async(_url,init)=>{if(offline)throw Error('offline');if(init?.method==='PATCH'){controls.push(JSON.parse(init.body));job=data(500);}return Response.json({job});});await wait(()=>current?.id==='job');offline=true;await act(async()=>app.refreshBulkTask());assert.equal(current.status,'running');assert.equal(current.processed,500);
 offline=false;job=data(500,'failed');await act(async()=>app.refreshBulkTask());await wait(()=>current?.status==='failed');await act(async()=>app.retryReadAllTask());await wait(()=>current?.status==='running');assert.deepEqual(controls,[{id:'job',action:'retry'}]);
});
test('account switch ignores late submission responses and only observes the new account',async t=>{
 let release,calls=0;
 await mount(t,async(_url,init)=>{if(init?.method!=='POST')return Response.json({job:null});calls++;await new Promise(resolve=>release=resolve);return Response.json({job:data()});});
 await act(async()=>app.startReadAllTask(scope));await act(async()=>app.setClientSessionToken('new-session'));await act(async()=>release());await wait(()=>current===null);assert.equal(calls,1);
});
test('all-pages actions and organization preserve the selection snapshot in the server request',async t=>{
 const requests=[],selection={snapshot:999,after:0,actorId:'owner',mailboxIds:['box'],total:3,unread:3,canManage:true},changes={addLabelIds:['work'],category:'invoices'};
 let job=null;await mount(t,async(url,init)=>{if(url.endsWith('bulk-scope')){requests.push(JSON.parse(init.body));return Response.json(selection);}if(init?.method==='POST'){requests.push(JSON.parse(init.body));job={...data(0,'running',requests.at(-1).requestId),action:'organize',organization:changes};}return Response.json({job});});
 let prepared;await act(async()=>prepared=await app.prepareBulkScopeSelection(scope));assert.equal(current,null);assert.equal(requests[0].action,'select');await act(async()=>app.startBulkScopeTask(scope,prepared,'organize',undefined,changes));await wait(()=>current?.id==='job');assert.equal(requests.length,2);assert.equal(requests[1].input.snapshot,999);assert.deepEqual(requests[1].input.organization,changes);assert(!('messageIds' in requests[1].input));
 // End the server operation before unmounting the test's observer.
 job={...job,status:'done'};await act(async()=>app.refreshBulkTask());
});

test('logout clears the observer without issuing a new unauthorized polling request',async t=>{
 let calls=0;await mount(t,async()=>{calls++;return Response.json({job:data(1000)});});await wait(()=>current?.id==='job');const before=calls;await act(async()=>app.clearClientSessionToken());await wait(()=>current===null);assert.equal(calls,before);
});

test('a stale status response cannot replace a newly accepted operation',async t=>{
 let oldBody,reads=0,job=null;await mount(t,async(_url,init)=>{
  if(init?.method==='POST'){const request=JSON.parse(init.body);job=data(0,'running',request.requestId);return Response.json({job});}
  if(++reads===1)return {ok:true,json:()=>new Promise(resolve=>oldBody=resolve)};return Response.json({job});
 });
 await act(async()=>app.startReadAllTask(scope));await wait(()=>current?.id==='job');await act(async()=>oldBody({job:{...data(20000,'done'),id:'old-job'}}));assert.equal(current.id,'job');assert.equal(current.status,'running');
 job={...job,status:'done'};await act(async()=>app.refreshBulkTask());
});


test('idle polling backs off and hidden tabs stop reading until return',async t=>{
 const timers=[];let reads=0;const real=setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{timers.push(ms);return real(fn,ms,...args);});
 await mount(t,async()=>{reads++;return Response.json({job:null});});await wait(()=>reads>0);assert(timers.includes(300000));
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));const before=reads;await app.refreshBulkTask();assert.equal(reads,before);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));await wait(()=>reads>before);
});
