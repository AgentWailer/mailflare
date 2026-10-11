import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','CustomEvent','Event','HTMLElement'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-visibility-client-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
const baseline=process.env.MAILFLARE_VISIBILITY_BASELINE_REF||process.argv.find(arg=>arg.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length);
const source=baseline?execFileSync('git',['show',baseline+':src/components/messages/use-label-visibility.ts'],{encoding:'utf8'}):readFileSync('src/components/messages/use-label-visibility.ts','utf8');
await build({stdin:{contents:source,resolveDir:join(process.cwd(),'src/components/messages'),loader:'ts'},outfile:join(dir,'entry.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const {useLabelVisibility}=await import(pathToFileURL(join(dir,'entry.mjs')).href);
const React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
let state;
function Harness(){state=useLabelVisibility('shared-mailbox');return React.createElement('div',null,state.hiddenLabelIds.join(','));}
async function fixture(t,fetcher){
 localStorage.clear();localStorage.setItem('mailflare-session-token','old-test-session');
 document.body.innerHTML='<div id="root"></div>';
 t.mock.method(globalThis,'fetch',fetcher);
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false,gcTime:0}}}),root=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(async()=>root.unmount());client.clear();});
 await act(async()=>root.render(React.createElement(QueryClientProvider,{client},React.createElement(Harness))));
 return client;
}
const flush=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});

test('a delayed response body cannot load another account\'s label preferences',async t=>{
 let resolveBody;
 const client=await fixture(t,async()=>({status:200,ok:true,json:()=>new Promise(resolve=>resolveBody=resolve)}));
 assert.equal(typeof resolveBody,'function');
 localStorage.setItem('mailflare-session-token','new-test-session');
 await act(async()=>resolveBody({hiddenLabelIds:['old-user-label']}));await flush();
 assert.deepEqual(state.hiddenLabelIds,[]);assert.equal(state.failed,true);
 assert.equal(client.getQueryData(['label-visibility','shared-mailbox']),undefined);
});

test('a delayed save after account replacement cannot overwrite the new account cache',async t=>{
 let resolveBody;
 t.after(async()=>{await act(async()=>resolveBody?.({hiddenLabelIds:[]}));});
 const client=await fixture(t,async(_url,init)=>init.method==='PATCH'?{status:200,ok:true,json:()=>new Promise(resolve=>resolveBody=resolve)}:Response.json({hiddenLabelIds:init.headers.get('Authorization')==='Bearer new-test-session'?['new-user-label']:[]}));
 await flush();assert.equal(state.isLoading,false);
 let pending;await act(async()=>{pending=state.setVisible({labelId:'old-user-label',visible:false}).then(()=>null,error=>error);});
 assert.equal(typeof resolveBody,'function');
 await act(async()=>{
  localStorage.setItem('mailflare-session-token','new-test-session');
  client.clear();client.setQueryData(['label-visibility','shared-mailbox'],{hiddenLabelIds:['new-user-label']});
 });
 let error;await act(async()=>{resolveBody({hiddenLabelIds:['old-user-label']});error=await pending;});
 assert.match(error.message,/Account changed/);
 assert.deepEqual(client.getQueryData(['label-visibility','shared-mailbox']).hiddenLabelIds,['new-user-label']);
});
