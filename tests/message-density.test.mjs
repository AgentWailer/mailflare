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
const dir=mkdtempSync(join(process.cwd(),'node_modules','mail-density-test-'));
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
await build({entryPoints:['src/components/messages/use-message-density.ts'],outfile:join(dir,'hook.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const {readMessageDensity,saveMessageDensity,useMessageDensity}=await import(pathToFileURL(join(dir,'hook.mjs'))),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
test('density synchronizes mounted consumers, other tabs and storage-disabled sessions',async()=>{
 const root=createRoot(document.getElementById('root'));
 function Consumer(){const [density]=useMessageDensity();return React.createElement('output',null,density);}
 await act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(Consumer),React.createElement(Consumer))));
 try{
  assert.equal(readMessageDensity(),'comfortable');
  await act(async()=>saveMessageDensity('compact'));
  assert.deepEqual([...document.querySelectorAll('output')].map(el=>el.textContent),['compact','compact']);assert.equal(localStorage.getItem('mailflare-message-density'),'compact');
  localStorage.setItem('mailflare-message-density','comfortable');await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:'mailflare-message-density'})));assert.equal(readMessageDensity(),'comfortable');
  const original=dom.window.Storage.prototype.setItem;dom.window.Storage.prototype.setItem=()=>{throw new Error('Storage denied');};
  try{await act(async()=>saveMessageDensity('compact'));assert.equal(readMessageDensity(),'compact');assert([...document.querySelectorAll('output')].every(el=>el.textContent==='compact'));}finally{dom.window.Storage.prototype.setItem=original;}
  localStorage.setItem('mailflare-message-density','invalid');await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:null})));assert.equal(readMessageDensity(),'comfortable');
 }finally{await act(async()=>root.unmount());}
});
