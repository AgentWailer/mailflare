import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mailflare.test', pretendToBeVisual: true });
for (const key of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLButtonElement','HTMLSelectElement','Node','NodeFilter','DOMParser','DocumentFragment','MutationObserver','CustomEvent','Event','MouseEvent','FocusEvent','localStorage']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
document.queryCommandState = () => false;
document.queryCommandValue = () => '';
const directory = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-compose-network-'));
after(() => { rmSync(directory, { recursive: true, force: true }); dom.window.close(); });
writeFileSync(join(directory,'navigation.mjs'), 'export function useRouter(){ return {push(){},replace(){}}; }');
writeFileSync(join(directory,'mailbox.mjs'), `const mailbox={id:'mailbox',domainId:'domain',localPart:'owner',hostname:'example.test',displayName:'Owner',signature:'',senderAddresses:['owner@example.test']}; const state={selectedMailbox:mailbox,mailboxes:[mailbox],setSelectedMailbox(){}}; export function useSelectedMailbox(){return state;}`);
await build({ stdin: { contents: `
 import React from 'react';
 import { LanguageProvider } from './src/components/language-provider.tsx';
 import { ComposeForm } from './src/components/compose/compose-form.tsx';
 export function Harness(){return <LanguageProvider initialLocale='en'><ComposeForm mode='popup' draftIdToLoad='draft'/></LanguageProvider>;}
`, loader:'tsx', resolveDir:process.cwd(), sourcefile:'compose-network-entry.tsx' }, outfile:join(directory,'entry.mjs'), bundle:true, platform:'node', format:'esm', packages:'external', jsx:'automatic', tsconfig:'tsconfig.json', alias:{'next/navigation':join(directory,'navigation.mjs'),'@/components/mailbox-provider':join(directory,'mailbox.mjs')}, logLevel:'silent' });
const { Harness } = await import(pathToFileURL(join(directory,'entry.mjs')).href);
const React = await import('react'); const { act } = React;
const { createRoot } = await import('react-dom/client');
let root;
async function mount(t, override) {
 localStorage.clear(); document.body.innerHTML='<div id="root"></div>';
 t.mock.method(globalThis,'fetch',async(input,init={})=>{
  const url=String(input); const result=await override(url,init); if(result) return result;
  if(url==='/api/drafts/draft' && !init.method) return Response.json({draft:{id:'draft',mailboxId:'mailbox',fromAddr:'owner@example.test',toAddr:'recipient@example.test',subject:'Test email',htmlBody:'<p>Keep this original message.</p>',textBody:'Keep this original message.',attachments:[]}});
  if(url.startsWith('/api/drafts')) return Response.json({draft:{id:'draft'}});
  if(url==='/api/templates') return Response.json({templates:[]});
  if(url==='/api/attachment-policy') return Response.json({maxMb:25,cloudThresholdBytes:3000000});
  return Response.json({});
 });
 root=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(async()=>root.unmount());root=null;});
 await act(async()=>root.render(React.createElement(Harness)));
}
const editor = () => document.querySelector('[contenteditable="true"]');
const send = () => document.querySelector('button[type="submit"]');
async function submit(){await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}

test('send network errors and non-JSON responses preserve the message and release the Send button',async t=>{
 let calls=0;
 await mount(t,async(url)=>{
  if(url!=='/api/send') return null;
  calls++;if(calls===1) throw new TypeError('Network disconnected');
  return new Response('<html>Bad gateway</html>',{status:502});
 });
 const original=editor().innerHTML;
 await submit(); assert.equal(calls,1);assert.equal(send().disabled,false);assert.equal(editor().innerHTML,original);
 assert.match(document.body.textContent,/Send failed/);
 await submit();assert.equal(calls,2);assert.equal(send().disabled,false);assert.equal(editor().innerHTML,original);
});

test('autosave failure leaves a persistent warning until a later edit saves successfully',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let failing=true,saves=0;
 await mount(t,async(url,init)=>{
  if(url==='/api/drafts/draft' && init.method==='PATCH') {saves++;if(failing) throw new TypeError('Network disconnected');}
  return null;
 });
 const original=editor().innerHTML;
 await act(async()=>t.mock.timers.tick(901));
 assert.ok(saves>=1);assert.equal(editor().innerHTML,original);
 assert.match(document.querySelector('[role="alert"]').textContent,/Draft could not be saved/);
 await act(async()=>t.mock.timers.tick(4000));
 assert.ok(document.querySelector('[role="alert"]'),'save warning must outlast transient toasts');
 failing=false;
 await act(async()=>{editor().innerHTML='<p>A later edit.</p>';editor().dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>t.mock.timers.tick(901));
 assert.ok(saves>=2);assert.equal(document.querySelector('[role="alert"]'),null);assert.match(editor().textContent,/A later edit/);
});
