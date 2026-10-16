import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test/inbox',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','CustomEvent','Event','HTMLElement','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,key,{configurable:true,value:typeof dom.window[key]==='function'&&key.endsWith('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.ResizeObserver=class{observe(){}disconnect(){}};
Object.defineProperty(HTMLElement.prototype,'clientWidth',{get:()=>1200});Object.defineProperty(HTMLElement.prototype,'clientHeight',{get:()=>800});
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-persistent-reader-'));after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
const write=(name,text)=>writeFileSync(join(dir,name),text);
write('navigation.ts',`import {useSyncExternalStore} from 'react';const listen=fn=>{window.addEventListener('fixture:navigate',fn);return ()=>window.removeEventListener('fixture:navigate',fn)};export const usePathname=()=>useSyncExternalStore(listen,()=>locationPath());function locationPath(){return window.location.pathname;}export const useRouter=()=>({push:path=>{window.history.pushState({},'',path);window.dispatchEvent(new Event('fixture:navigate'))}});`);
write('sidebar.ts',`const setForcedMinimal=()=>{};export const useSidebar=()=>({userId:'owner',setForcedMinimal});`);
write('assistant.ts','export const useAssistantOpen=()=>false;');
write('detail.tsx','export const MessageDetailNavigationProvider=({children})=>children;');
write('list.tsx',`import React from 'react';import {useMessageOpening} from '@/components/messages/message-opening';export function MessageFolderPage({selection}){window.__openMessage=useMessageOpening();window.__listSelection=selection;React.useEffect(()=>{window.__listMounts++;return ()=>window.__listUnmounts++},[]);return <div data-message-list><input aria-label="Filter" defaultValue=""/><div data-scroll-list/><button onClick={()=>selection.setSelectedMessages([{id:'chosen',read:true,mailboxId:'box'}])}>Select</button><output>{selection.selectedMessages.length}</output></div>}`);
await build({stdin:{contents:"export {MessageSplitLayout} from './src/components/messages/message-split-layout';export {MessageCategoryLayout} from './src/components/messages/message-category-layout';export {LanguageProvider} from './src/components/language-provider';",resolveDir:process.cwd(),loader:'tsx'},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'@/components/messages/message-opening':join(process.cwd(),'src/components/messages/message-opening.tsx'),'next/navigation':join(dir,'navigation.ts'),'@/components/sidebar-state':join(dir,'sidebar.ts'),'@/components/agent/assistant-open-state':join(dir,'assistant.ts')},plugins:[{name:'list-and-detail',setup(b){b.onResolve({filter:/^\.\/(message-folder-page|message-detail-navigation)$/},args=>({path:join(dir,args.path.endsWith('message-folder-page')?'list.tsx':'detail.tsx')}));}}],logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const de=JSON.parse(readFileSync('public/locales/de.json','utf8'));
let root;
async function mount(t,{layout='bottom',locale='de',prefix='/inbox',visible=true,category=false,ratio,legacyHeight}={}){localStorage.clear();if(ratio!==undefined)localStorage.setItem('mailflare-column-width:message-list-ratio:owner',String(ratio));if(legacyHeight!==undefined)localStorage.setItem('mailflare-column-width:message-list-height:owner',String(legacyHeight));localStorage.setItem('mailflare-reading-layout',layout);localStorage.setItem('mailflare-message-list-visible',String(visible));window.history.replaceState({},'',prefix);window.__listMounts=0;window.__listUnmounts=0;document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));await act(async()=>root.render(React.createElement(app.LanguageProvider,{initialLocale:locale,initialMessages:locale==='de'?de:undefined},React.createElement(category?app.MessageCategoryLayout:app.MessageSplitLayout,{config:{folder:'inbox',title:'Inbox',hrefPrefix:prefix}},React.createElement('div',{'data-route-content':true},'Route content')))));}
const navigate=path=>act(async()=>{window.history.replaceState({},'',path);window.dispatchEvent(new Event('fixture:navigate'));});

test('overview keeps a stable empty reader without opening a conversation automatically',async t=>{
 await mount(t);assert.equal(window.location.pathname,'/inbox');assert.equal(document.querySelector('[data-empty-reader]').textContent,'Keine Konversation ausgewählt');assert.equal(document.querySelectorAll('[data-message-list]').length,1);assert.equal(document.querySelector('[data-route-content]'),null);assert.equal(window.__listMounts,1);
 await act(async()=>window.dispatchEvent(new Event('mailflare:messages-changed')));assert.equal(window.location.pathname,'/inbox');assert.equal(window.__listMounts,1);
});

for(const layout of ['bottom','right'])test(`${layout} pane preserves the list DOM, scroll, filter, selection and dimensions across opening/closing mail`,async t=>{
 await mount(t,{layout});const pane=document.querySelector('[data-message-reading-pane]'),list=document.querySelector('[data-message-list]'),scroll=document.querySelector('[data-scroll-list]'),filter=document.querySelector('input');const grid=document.querySelector('[data-reading-layout]');const columns=grid.style.gridTemplateColumns,rows=grid.style.gridTemplateRows;scroll.scrollTop=173;filter.value='billing@example.test';await act(async()=>document.querySelector('[data-message-list] button').click());
 for(const path of ['/inbox/one','/inbox/two','/inbox']){await navigate(path);assert.equal(document.querySelector('[data-message-reading-pane]'),pane);assert.equal(document.querySelector('[data-message-list]'),list);assert.equal(document.querySelector('input'),filter);assert.equal(filter.value,'billing@example.test');assert.equal(scroll.scrollTop,173);assert.equal(document.querySelector('output').textContent,'1');assert.equal(grid.style.gridTemplateColumns,columns);assert.equal(grid.style.gridTemplateRows,rows);assert.equal(window.__listMounts,1);assert.equal(window.__listUnmounts,0);}
 assert(document.querySelector('[data-empty-reader]'));
});

test('English empty state and custom label routes use the persistent pane',async t=>{
 await mount(t,{locale:'en',prefix:'/folders/work'});assert.equal(document.querySelector('[data-empty-reader]').textContent,'No conversation selected');await navigate('/folders/work/one');assert(document.querySelector('[data-route-content]'));await navigate('/folders/work');assert(document.querySelector('[data-empty-reader]'));assert.equal(window.__listMounts,1);
});

test('disabled reading preference keeps a full list and only renders the reader when explicitly opened',async t=>{
 await mount(t,{layout:'off'});assert.equal(document.querySelector('[data-message-reading-pane]'),null);assert(document.querySelector('[data-route-content]'));assert.equal(window.location.pathname,'/inbox');await navigate('/inbox/one');assert(document.querySelector('[data-message-reading-pane]'));assert.equal(document.querySelector('[data-message-list]'),null);assert.equal(document.querySelector('[data-empty-reader]'),null);
});

test('returning to the overview restores a reachable list after the reader list was hidden',async t=>{
 await mount(t,{visible:false});await navigate('/inbox/one');assert.equal(document.querySelector('[data-reading-layout] > aside').getAttribute('aria-hidden'),'true');await navigate('/inbox');const aside=document.querySelector('[data-reading-layout] > aside');assert.equal(aside.getAttribute('aria-hidden'),'false');assert.equal(aside.hasAttribute('inert'),false);
});


test('a first click shows the selected subject before route loading finishes and can be cancelled',async t=>{
 await mount(t);const list=document.querySelector('[data-message-list]'),pane=document.querySelector('[data-message-reading-pane]');
 await act(async()=>window.__openMessage.open({id:'early',subject:'Early selected message'},'/inbox/early'));
 assert.equal(window.location.pathname,'/inbox');assert.equal(document.querySelector('[data-message-opening] h1').textContent,'Early selected message');assert.equal(document.querySelector('[data-message-list]'),list);assert.equal(document.querySelector('[data-message-reading-pane]'),pane);
 await act(async()=>document.querySelector('[data-message-back]').click());assert.equal(document.querySelector('[data-message-opening]'),null);assert(document.querySelector('[data-empty-reader]'));assert.equal(window.__listUnmounts,0);
 await act(async()=>window.__openMessage.open({id:'early',subject:'Early selected message'},'/inbox/early'));await navigate('/inbox/early');assert.equal(document.querySelector('[data-message-opening]'),null);assert(document.querySelector('[data-route-content]'));assert.equal(document.querySelector('[data-message-list]'),list);
});

for(const layout of ['bottom','right','off'])test(`${layout}: category overviews share the same mounted list and reset selection`,async t=>{
 await mount(t,{layout,category:true});
 const list=document.querySelector('[data-message-list]'),pane=document.querySelector('[data-message-reading-pane]'),mounts=window.__listMounts,unmounts=window.__listUnmounts;
 assert(list,'the shared layout owns the overview even with the reader disabled');
 assert.equal(document.querySelector('[data-route-content]'),null);
 await act(async()=>{window.__listSelection.setOffset(25);window.__listSelection.setUnreadOnly(true);document.querySelector('[data-message-list] button').click();});assert.equal(document.querySelector('output').textContent,'1');assert.equal(window.__listSelection.offset,25);assert.equal(window.__listSelection.unreadOnly,true);
 for(const path of ['/invoices','/promotions','/social','/orders','/inbox']){
  await navigate(path);assert.equal(document.querySelector('[data-message-list]'),list);assert.equal(document.querySelector('[data-message-reading-pane]'),pane);
  assert.equal(document.querySelector('output').textContent,'0','selection never carries into another category');assert.equal(window.__listSelection.offset,0);assert.equal(window.__listSelection.unreadOnly,false);assert.equal(window.__listMounts,mounts);assert.equal(window.__listUnmounts,unmounts);
 }
});

for(const ratio of [undefined,.65])test(`bottom pane uses a proportional split (${ratio??'fresh default'}) instead of the legacy pixel height`,async t=>{await mount(t,{ratio,legacyHeight:280});const grid=document.querySelector('[data-reading-layout]');assert.equal(grid.style.gridTemplateRows,`minmax(0,${ratio??.5}fr) minmax(0,${1-(ratio??.5)}fr)`);await navigate('/inbox/one');assert.equal(grid.style.gridTemplateRows,`minmax(0,${ratio??.5}fr) minmax(0,${1-(ratio??.5)}fr)`);});
