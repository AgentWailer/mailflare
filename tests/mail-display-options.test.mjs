import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test'});
for(const key of ['window','document','localStorage','Event','StorageEvent'])globalThis[key]=dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mail-display-test-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
await build({entryPoints:['src/components/messages/use-mail-display-options.ts'],outfile:join(dir,'hook.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const {parseMailDisplay,readMailDisplayOptions,useMailDisplayOptions}=await import(pathToFileURL(join(dir,'hook.mjs'))),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
test('invalid persisted display data cannot request unbounded lists or disable controls accidentally',()=>{
 for(const raw of ['null','broken','[]','{"pageSize":60000,"categories":"false"}'])assert.deepEqual(parseMailDisplay(raw),{categories:true,preview:true,unreadMarks:true,avatars:false,pageSize:25});
 assert.equal(parseMailDisplay('{"pageSize":50,"preview":false}').pageSize,50);
});
test('display changes synchronize consumers and tabs, and survive unavailable storage',async()=>{
 const root=createRoot(document.getElementById('root'));let update;
 function Consumer(){const [options,set]=useMailDisplayOptions();update=set;return React.createElement('output',null,JSON.stringify(options));}
 await act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(Consumer),React.createElement(Consumer))));
 try{
  await act(async()=>{update({preview:false});update({pageSize:50});});
  for(const el of document.querySelectorAll('output')){const state=JSON.parse(el.textContent);assert.equal(state.preview,false);assert.equal(state.pageSize,50);}
  assert.equal(JSON.parse(localStorage.getItem('mailflare-display-options')).preview,false);
  localStorage.setItem('mailflare-display-options','{"avatars":true}');await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:'mailflare-display-options'})));assert.equal(readMailDisplayOptions().avatars,true);
  const original=dom.window.Storage.prototype.setItem;dom.window.Storage.prototype.setItem=()=>{throw Error('denied');};
  try{await act(async()=>update({categories:false}));assert.equal(readMailDisplayOptions().categories,false);}finally{dom.window.Storage.prototype.setItem=original;}
 }finally{await act(async()=>root.unmount());}
});
