import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','CustomEvent','Event','HTMLElement'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-label-order-client-'));after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
writeFileSync(join(dir,'language.ts'),'export const useLanguage=()=>({t:(key)=>key});');
await build({entryPoints:['src/components/use-label-order.ts'],outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',plugins:[{name:'language',setup(b){b.onResolve({filter:/language-provider$/},()=>({path:join(dir,'language.ts')}));}}],logLevel:'silent'});
const {useLabelOrder}=await import(pathToFileURL(join(dir,'app.mjs')).href),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client'),{QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
let state;const groups=new Map([[null,[{id:'a',name:'A'},{id:'b',name:'B'}]]]);function Harness(){state=useLabelOrder('box',groups);return React.createElement('div',null,JSON.stringify(state.orders));}
const flush=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
async function fixture(t,fetcher){localStorage.clear();localStorage.setItem('mailflare-session-token','old');document.body.innerHTML='<div id="root"></div>';t.mock.method(globalThis,'fetch',fetcher);const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{gcTime:0}}}),root=createRoot(document.getElementById('root'));t.after(async()=>{await act(async()=>root.unmount());client.clear();});await act(async()=>root.render(React.createElement(QueryClientProvider,{client},React.createElement(Harness))));return client;}
test('late reads cannot install preferences from the previous account',async t=>{
 let body;const client=await fixture(t,async()=>({ok:true,status:200,json:()=>new Promise(resolve=>body=resolve)}));assert.equal(typeof body,'function');localStorage.setItem('mailflare-session-token','new');await act(async()=>body({orders:{root:['b','a']}}));await flush();assert.deepEqual(state.orders,{});assert.equal(client.getQueryData(['label-order','box']),undefined);
});
test('late saves cannot invalidate or overwrite the new account cache',async t=>{
 let response;const client=await fixture(t,async(_url,init)=>init.method==='PATCH'?new Promise(resolve=>response=resolve):Response.json({orders:{root:init.headers.get('Authorization')==='Bearer new'?['new-user-label']:['a','b']}}));await flush();await act(async()=>state.saveOrder(null,['b','a']));assert.equal(typeof response,'function');await act(async()=>{localStorage.setItem('mailflare-session-token','new');client.clear();client.setQueryData(['label-order','box'],{orders:{root:['new-user-label']}});response(Response.json({ok:true}));});await flush();assert.deepEqual(client.getQueryData(['label-order','box']).orders.root,['new-user-label']);
});
test('rapid consecutive moves save serially and a pending save keeps its optimistic order',async t=>{
 const posted=[];let release;let server=['a','b'];const client=await fixture(t,async(_url,init)=>{if(init.method!=='PATCH')return Response.json({orders:{root:server}});const body=JSON.parse(init.body);posted.push(body.order);if(posted.length===1)await new Promise(resolve=>release=resolve);server=body.order;return Response.json({ok:true});});await flush();await act(async()=>{state.saveOrder(null,['b','a']);state.saveOrder(null,['a','b']);});await flush();assert.equal(posted.length,1);assert.deepEqual(state.orders.root,['a','b']);await act(async()=>release());await flush();assert.deepEqual(posted,[['b','a'],['a','b']]);assert.deepEqual(server,['a','b']);assert.equal(client.isMutating(),0);
});
