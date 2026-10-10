import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLButtonElement','HTMLSelectElement','Node','NodeFilter','DOMParser','DocumentFragment','MutationObserver','CustomEvent','Event','MouseEvent','FocusEvent','localStorage'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
document.queryCommandState=()=>false;document.queryCommandValue=()=>'';
const directory=mkdtempSync(join(process.cwd(),'node_modules','mailflare-refine-ui-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
await build({stdin:{contents:`
 import React, { useState } from 'react';
 import { LanguageProvider } from './src/components/language-provider.tsx';
 import { RichTextEditor } from './src/components/compose/rich-text-editor.tsx';
 import de from './public/locales/de.json';
 export function Harness({ locale='en', mailboxId='mailbox', initialValue='<p>Hello badly worded text.</p>' }) {
  const [value, setValue] = useState(initialValue);
  return <LanguageProvider initialLocale={locale} initialMessages={locale==='de'?de:undefined}><RichTextEditor id='editor' mailboxId={mailboxId} value={value} onChange={setValue} /></LanguageProvider>;
 }
`,loader:'tsx',resolveDir:process.cwd(),sourcefile:'refine-ui-entry.tsx'},outfile:join(directory,'entry.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',logLevel:'silent'});
const { Harness }=await import(pathToFileURL(join(directory,'entry.mjs')).href);
const React=await import('react');const { act }=React;
const { createRoot }=await import('react-dom/client');
let root;
async function mount(props){document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Harness,props)));}
async function cleanup(){if(root){await act(async()=>root.unmount());root=null;}}
function button(label){const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);assert.ok(b,`Button missing: ${label}`);return b;}
async function click(label){await act(async()=>{const b=button(label);b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));b.dispatchEvent(new MouseEvent('click',{bubbles:true}));});}
function editor(){return document.getElementById('editor');}

test('German selection UI previews without changing the draft; apply replaces only the selection and undo restores it',async(t)=>{
 t.after(cleanup);const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,'/api/compose/refine');calls.push(JSON.parse(init.body));return Response.json({text:'gut formulierter Text'});});
 await mount({locale:'de'});
 const before=editor().innerHTML;const node=editor().firstChild.firstChild;
 const range=document.createRange();range.setStart(node,6);range.setEnd(node,23);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
 await click('Überarbeiten');
 assert.equal(document.querySelector('select').value,'selection');
 const language=Array.from(document.querySelectorAll('select')).find(s=>s.querySelector('option[value="en"]'));
 await act(async()=>{language.value='de';language.dispatchEvent(new Event('change',{bubbles:true}));});
 await click('Vorschlag erstellen');assert.equal(calls[0].text,'badly worded text');assert.equal(calls[0].language,'de');
 assert.equal(editor().innerHTML,before);assert.equal(document.querySelector('textarea').value,'gut formulierter Text');
 await click('Abbrechen');assert.equal(editor().innerHTML,before);
 selection.removeAllRanges();const newRange=document.createRange();newRange.setStart(node,6);newRange.setEnd(node,23);selection.addRange(newRange);
 await click('Überarbeiten');await click('Vorschlag erstellen');await click('Übernehmen');
 assert.equal(editor().textContent,'Hello gut formulierter Text.');
 await click('Überarbeitung rückgängig machen');assert.equal(editor().innerHTML,before);
});

test('English whole-email UI keeps the signature, and refuses application after changing the sending mailbox',async(t)=>{
 t.after(cleanup);const calls=[];
 t.mock.method(globalThis,'fetch',async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:'A clearer message.'});});
 window.getSelection().removeAllRanges();
 await mount({initialValue:'<p>Original message.</p><div data-mailflare-signature="1">Sam</div>'});
 const before=editor().innerHTML;
 await click('Refine');assert.equal(document.querySelector('select').value,'message');
 await click('Generate suggestion');assert.equal(calls[0].text,'Original message.');assert.equal(calls[0].language,'keep');
 await act(async()=>root.render(React.createElement(Harness,{mailboxId:'different-mailbox'})));
 await click('Apply');assert.equal(editor().innerHTML,before);assert.match(document.querySelector('[role="alert"]').textContent,/changed/);
 await click('Cancel');window.getSelection().removeAllRanges();await click('Refine');await click('Generate suggestion');await click('Apply');
 assert.equal(editor().querySelector('[data-mailflare-signature]').textContent,'Sam');assert.equal(editor().firstChild.textContent,'A clearer message.');
});

test('cancel during generation aborts the request and leaves the email unchanged',async(t)=>{
 t.after(cleanup);let signal;
 t.mock.method(globalThis,'fetch',(_url,init)=>new Promise((_resolve,reject)=>{signal=init.signal;signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));}));
 window.getSelection().removeAllRanges();await mount({});const before=editor().innerHTML;
 await click('Refine');await click('Generate suggestion');assert.equal(signal.aborted,false);
 await click('Cancel');assert.equal(signal.aborted,true);assert.equal(editor().innerHTML,before);assert.equal(document.querySelector('[role="dialog"]'),null);
});
