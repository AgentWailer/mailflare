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


test('one click updates only the selected passage in the actual draft, with immediate undo and no Replace step',async t=>{
 t.after(cleanup);const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:'gut formulierter Text'});});
 await mount({locale:'de'});const before=editor().innerHTML,node=editor().firstChild.firstChild;
 const range=document.createRange();range.setStart(node,6);range.setEnd(node,23);window.getSelection().addRange(range);
 await click('Überarbeiten');assert.equal(calls.length,1);assert.equal(calls[0].text,'badly worded text');
 assert.equal(editor().textContent,'Hello gut formulierter Text.');assert.equal(draft(),editor().innerHTML);assert.equal(preview(),null);assert.equal(button('Send').disabled,false);assert(!document.body.textContent.includes('Ersetzen'));
 await click('Überarbeitung rückgängig machen');assert.equal(editor().innerHTML,before);assert.equal(draft(),before);
});

test('style and language are chosen before generation and reused; consecutive revisions undo one at a time',async t=>{
 t.after(cleanup);const calls=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:'Suggestion '+calls.length});});
 await mount({});const before=draft();await click('Refine settings');
 for(const [value] of [['de'],['shorter']]){const select=[...document.querySelectorAll('select')].find(s=>s.querySelector('option[value="'+value+'"]'));await act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}
 assert.equal(calls.length,0);await click('Refine');assert.equal(calls[0].language,'de');assert.equal(calls[0].mode,'shorter');const first=draft();
 await click('Refine');assert.equal(calls[1].text,'Suggestion 1');assert.equal(calls[1].language,'de');
 await click('Undo refinement');assert.equal(draft(),first);await click('Undo refinement');assert.equal(draft(),before);
});

test('whole-email changes preserve the signature, and mailbox switches discard a pending request and its undo history',async t=>{
 t.after(cleanup);let resolve,signal;t.mock.method(globalThis,'fetch',(_url,init)=>{signal=init.signal;return new Promise(r=>resolve=r);});
 const props={initialValue:'<p>Original message.</p><div data-mailflare-signature="1">Sam</div>'};await mount(props);const before=draft();await click('Refine');
 await act(async()=>resolve(Response.json({text:'A clearer message.'})));assert.equal(editor().querySelector('[data-mailflare-signature]').textContent,'Sam');assert.equal(editor().firstChild.textContent,'A clearer message.');
 await click('Refine');await act(async()=>root.render(React.createElement(Harness,{...props,mailboxId:'different-mailbox'})));assert.equal(signal.aborted,true);assert(!document.querySelector('[data-compose-ai-undo]'));
 await act(async()=>resolve(Response.json({text:'Late wrong-mailbox result'})));assert.equal(editor().firstChild.textContent,'A clearer message.');assert.notEqual(draft(),before);
});

test('cancel aborts generation and ignores a late result even if the provider ignores cancellation',async t=>{
 t.after(cleanup);let signal,resolve;t.mock.method(globalThis,'fetch',(_url,init)=>{signal=init.signal;return new Promise(r=>resolve=r);});
 await mount({});const before=draft();await click('Refine');assert.equal(button('Send').disabled,true);await click('Cancel');assert.equal(signal.aborted,true);assert.equal(button('Send').disabled,false);
 await act(async()=>resolve(Response.json({text:'Late suggestion'})));assert.equal(draft(),before);assert.equal(preview(),null);
});

test('blank new emails focus the writing instruction; failures preserve the draft and support retry and cancel',async t=>{
 t.after(cleanup);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({code:'provider_error'},{status:502});});
 await mount({initialValue:'<div data-mailflare-signature="1">Sam</div>'});const before=draft();await click('Refine');assert.equal(calls,0);assert.equal(document.activeElement.getAttribute('aria-label'),'Writing instruction');assert.equal(draft(),before);
 await cleanup();await mount({});const original=draft();await click('Refine');assert.equal(calls,1);assert.match(document.querySelector('[role="alert"]').textContent,/failed/);await click('Try again');assert.equal(calls,2);await click('Cancel');assert.equal(draft(),original);
});

test('blank replies generate directly from conversation context and undo preserves signature and quotes',async t=>{
 t.after(cleanup);const calls=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:'Hallo Julia, gerne besprechen wir die nächsten Schritte.'});});
 const replyContext={threadId:'thread',inReplyTo:'source@example.test',subject:'Re: Next steps',from:'sam@example.test',to:'julia@example.test'};
 await mount({locale:'de',initialValue:'<div><br></div><div data-mailflare-signature="1">Sam</div>',quotedHtml:'<p>Original conversation</p>',replyContext});const original=draft();
 await click('Überarbeiten');assert.equal(calls[0].action,'reply');assert.deepEqual(calls[0].replyContext,replyContext);assert.ok(editor().textContent.startsWith('Hallo Julia'));assert.equal(editor().querySelector('[data-mailflare-signature]').textContent,'Sam');assert.equal(button('Send').disabled,false);
 await click('Überarbeitung rückgängig machen');assert.equal(draft(),original);
});

test('a pending reply is discarded if recipients or conversation context change',async t=>{
 t.after(cleanup);let resolve,signal;t.mock.method(globalThis,'fetch',(_url,init)=>{signal=init.signal;return new Promise(r=>resolve=r);});
 const props={initialValue:'<div data-mailflare-signature="1">Sam</div>',replyContext:{threadId:'thread',to:'julia@example.test'}};await mount(props);const before=draft();await click('Refine');
 await act(async()=>root.render(React.createElement(Harness,{...props,replyContext:{...props.replyContext,to:'different@example.test'}})));assert.equal(signal.aborted,true);assert.equal(button('Send').disabled,false);
 await act(async()=>resolve(Response.json({text:'Late answer'})));assert.equal(draft(),before);
});

test('keyboard undo restores an AI change, while subsequent manual edits cannot be overwritten by the undo button',async t=>{
 t.after(cleanup);t.mock.method(globalThis,'fetch',async()=>Response.json({text:'Improved.'}));await mount({});const before=draft();await click('Refine');
 await act(async()=>editor().dispatchEvent(new window.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true})));assert.equal(draft(),before);
 await click('Refine');await act(async()=>{editor().innerHTML='<p>My new manual edit.</p>';editor().dispatchEvent(new Event('input',{bubbles:true}));});assert(!document.querySelector('[data-compose-ai-undo]'));assert.equal(draft(),'<p>My new manual edit.</p>');
});

test('writing instructions generate a new body in place, preserve the signature and can be undone',async t=>{
 t.after(cleanup);const calls=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({text:'Thank you for the meeting.'});});
 await mount({initialValue:'<div data-mailflare-signature="1">Sam</div>'});const original=draft();const input=document.querySelector('input[aria-label="Writing instruction"]');
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Thank Julia for the meeting');input.dispatchEvent(new Event('input',{bubbles:true}));});await click('Generate text');
 assert.equal(calls[0].action,'compose');assert.equal(calls[0].instruction,'Thank Julia for the meeting');assert.ok(editor().textContent.startsWith('Thank you'));assert.equal(editor().querySelector('[data-mailflare-signature]').textContent,'Sam');await click('Undo refinement');assert.equal(draft(),original);
});

test('incomplete image output and invalid model text do not alter the draft',async t=>{
 t.after(cleanup);t.mock.method(globalThis,'fetch',async()=>Response.json({text:'Missing the original image.'}));await mount({initialValue:'<p>Hello</p><img src="/image.png">'});const before=draft();await click('Refine');assert.equal(draft(),before);assert.ok(document.querySelector('[role="alert"]'));await click('Cancel');assert.equal(draft(),before);
});
