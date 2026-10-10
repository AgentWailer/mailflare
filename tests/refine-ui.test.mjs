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
 export function Harness({ locale='en', mailboxId='mailbox', initialValue='<p>Hello badly worded text.</p>', replyContext, quotedHtml }) {
  const [value, setValue] = useState(initialValue); const [refining, setRefining] = useState(false);
  return <LanguageProvider initialLocale={locale} initialMessages={locale==='de'?de:undefined}><RichTextEditor id='editor' mailboxId={mailboxId} replyContext={replyContext} quotedHtml={quotedHtml} value={value} onChange={setValue} onRefineActiveChange={setRefining} toolbarStart={<button type='submit' disabled={refining}>Send</button>} /><output data-draft={value} /></LanguageProvider>;
 }
`,loader:'tsx',resolveDir:process.cwd(),sourcefile:'refine-ui-entry.tsx'},outfile:join(directory,'entry.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',logLevel:'silent'});
const { Harness }=await import(pathToFileURL(join(directory,'entry.mjs')).href);
const React=await import('react');const { act }=React;
const { createRoot }=await import('react-dom/client');
let root;
async function mount(props){localStorage.clear();window.getSelection().removeAllRanges();document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Harness,props)));}
async function cleanup(){if(root){await act(async()=>root.unmount());root=null;}}
function button(label){const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);assert.ok(b,`Button missing: ${label}`);return b;}
async function click(label){await act(async()=>{const b=button(label);b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));b.dispatchEvent(new MouseEvent('click',{bubbles:true}));});}
function editor(){return document.getElementById('editor');}

function preview(){return document.querySelector('[aria-label="Suggested revision"], [aria-label="Vorschlag"]');}
function draft(){return document.querySelector('output').getAttribute('data-draft');}

test('one click previews a selection inline without changing the draft; cancel, replace and undo preserve surrounding content',async(t)=>{
 t.after(cleanup);const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,'/api/compose/refine');calls.push(JSON.parse(init.body));return Response.json({text:'gut formulierter Text'});});
 await mount({locale:'de'});
 assert.equal(button('Überarbeiten').textContent,'');
 assert.equal(button('Überarbeiten').parentElement.nextElementSibling.textContent,'Send');
 const before=editor().innerHTML;const node=editor().firstChild.firstChild;
 function selectPassage(){const range=document.createRange();range.setStart(node,6);range.setEnd(node,23);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}
 selectPassage();await click('Überarbeiten');
 assert.equal(calls.length,1);assert.equal(calls[0].text,'badly worded text');assert.equal(calls[0].language,'keep');
 assert.equal(document.querySelector('[role="dialog"]'),null);assert.equal(document.querySelector('textarea'),null);
 assert.equal(editor().innerHTML,before);assert.equal(draft(),before);
 assert.equal(preview().textContent,'Hello gut formulierter Text.');assert.equal(button('Send').disabled,true);
 await click('Abbrechen');assert.equal(editor().innerHTML,before);assert.equal(preview(),null);assert.equal(button('Send').disabled,false);
 selectPassage();await click('Überarbeiten');await click('Ersetzen');
 assert.equal(editor().textContent,'Hello gut formulierter Text.');assert.equal(preview(),null);assert.equal(button('Send').disabled,false);
 await click('Überarbeitung rückgängig machen');assert.equal(editor().innerHTML,before);assert.equal(draft(),before);
});

test('settings regenerate immediately and persist; retry always uses the original text',async(t)=>{
 t.after(cleanup);const calls=[];
 t.mock.method(globalThis,'fetch',async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:`Suggestion ${calls.length}`});});
 await mount({});const before=draft();await click('Refine');
 await click('Refine settings');
 const language=Array.from(document.querySelectorAll('select')).find(s=>s.querySelector('option[value="en"]'));
 await act(async()=>{language.value='de';language.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(calls.length,2);assert.equal(calls[1].language,'de');
 const style=Array.from(document.querySelectorAll('select')).find(s=>s.querySelector('option[value="shorter"]'));
 await act(async()=>{style.value='shorter';style.dispatchEvent(new Event('change',{bubbles:true}));});
 await click('Try again');assert.equal(calls.length,4);assert.ok(calls.every(c=>c.text==='Hello badly worded text.'));
 assert.equal(draft(),before);await click('Cancel');await click('Refine');
 assert.equal(calls[4].language,'de');assert.equal(calls[4].mode,'shorter');
});

test('whole-email preview preserves signature and is discarded when the sending mailbox changes',async(t)=>{
 t.after(cleanup);const calls=[];
 t.mock.method(globalThis,'fetch',async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:'A clearer message.'});});
 await mount({initialValue:'<p>Original message.</p><div data-mailflare-signature="1">Sam</div>'});
 const before=editor().innerHTML;
 await click('Refine');assert.equal(calls[0].text,'Original message.');assert.equal(calls[0].language,'keep');
 assert.equal(preview().querySelector('[data-mailflare-signature]').textContent,'Sam');
 await act(async()=>root.render(React.createElement(Harness,{mailboxId:'different-mailbox'})));
 assert.equal(editor().innerHTML,before);assert.equal(preview(),null);assert.equal(button('Send').disabled,false);
 window.getSelection().removeAllRanges();await click('Refine');await click('Replace');
 assert.equal(editor().querySelector('[data-mailflare-signature]').textContent,'Sam');assert.equal(editor().firstChild.textContent,'A clearer message.');
});

test('cancel aborts generation and ignores a late result even if the provider ignores cancellation',async(t)=>{
 t.after(cleanup);let signal, resolve;
 t.mock.method(globalThis,'fetch',(_url,init)=>{signal=init.signal;return new Promise(r=>{resolve=r;});});
 await mount({});const before=editor().innerHTML;
 await click('Refine');assert.equal(signal.aborted,false);assert.equal(button('Send').disabled,true);
 await click('Cancel');assert.equal(signal.aborted,true);assert.equal(button('Send').disabled,false);
 await act(async()=>resolve(Response.json({text:'Late suggestion'})));
 assert.equal(editor().innerHTML,before);assert.equal(preview(),null);assert.equal(draft(),before);
});

test('empty text and provider failures leave the original draft intact and remain cancellable',async(t)=>{
 t.after(cleanup);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({code:'provider_error'},{status:502});});
 await mount({initialValue:'<div data-mailflare-signature="1">Sam</div>'});const before=draft();
 await click('Refine');assert.equal(calls,0);assert.match(document.querySelector('[role="alert"]').textContent,/No conversation history/);
 await click('Cancel');assert.equal(draft(),before);
 await cleanup();await mount({});await click('Refine');assert.equal(calls,1);assert.match(document.querySelector('[role="alert"]').textContent,/failed/);
 await click('Try again');assert.equal(calls,2);await click('Cancel');assert.equal(preview(),null);
});


test('blank replies generate from conversation context immediately; cancel, retry, replace and undo keep the signature and quotes',async(t)=>{
 t.after(cleanup);const calls=[];
 t.mock.method(globalThis,'fetch',async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:'Hallo Julia, gerne besprechen wir die nächsten Schritte.'});});
 const replyContext={threadId:'thread',inReplyTo:'source@example.test',subject:'Re: Next steps',from:'sam@example.test',to:'julia@example.test'};
 await mount({locale:'de',initialValue:'<div><br></div><div data-mailflare-signature="1">Sam</div>',quotedHtml:'<p>Original conversation</p>',replyContext});
 const original=editor().innerHTML;await click('Überarbeiten');assert.equal(calls.length,1);assert.equal(calls[0].action,'reply');assert.equal(calls[0].text,'');assert.deepEqual(calls[0].replyContext,replyContext);
 assert.equal(editor().innerHTML,original);assert.equal(draft(),original);assert.equal(preview().querySelector('[data-mailflare-signature]').textContent,'Sam');assert.equal(button('Send').disabled,true);
 await click('Abbrechen');assert.equal(draft(),original);await click('Überarbeiten');await click('Neu');assert.equal(calls[2].text,'');
 await click('Ersetzen');assert.ok(editor().textContent.startsWith('Hallo Julia'));assert.equal(editor().querySelector('[data-mailflare-signature]').textContent,'Sam');
 await click('Überarbeiten');assert.equal(calls.at(-1).action,undefined);assert.ok(calls.at(-1).text.startsWith('Hallo Julia'));await click('Abbrechen');
 await click('Überarbeitung rückgängig machen');assert.equal(draft(),original);
});

test('a pending reply is discarded if recipients or conversation context change',async(t)=>{
 t.after(cleanup);let resolve,signal;
 t.mock.method(globalThis,'fetch',(_url,init)=>{signal=init.signal;return new Promise(r=>{resolve=r;});});
 const props={initialValue:'<div data-mailflare-signature="1">Sam</div>',replyContext:{threadId:'thread',to:'julia@example.test'}};
 await mount(props);const before=draft();await click('Refine');
 await act(async()=>root.render(React.createElement(Harness,{...props,replyContext:{...props.replyContext,to:'different@example.test'}})));
 assert.equal(signal.aborted,true);assert.equal(button('Send').disabled,false);
 await act(async()=>resolve(Response.json({text:'Late answer to the old recipient'})));assert.equal(draft(),before);assert.equal(preview(),null);
});
