import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test/inbox',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','CustomEvent','Event','HTMLElement'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const media=new window.EventTarget();let desktop=true;Object.defineProperty(media,'matches',{get:()=>desktop});window.matchMedia=()=>media;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-initial-preview-'));after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
writeFileSync(join(dir,'mailbox.ts'),"export const useSelectedMailbox=()=>({selectedMailbox:{id:window.__mailbox},isLoading:false});");
writeFileSync(join(dir,'search.ts'),"export const useMailSearch=()=>({query:window.__query||''});");
writeFileSync(join(dir,'navigation.ts'),`import {useSyncExternalStore} from 'react';const subscribe=fn=>{window.addEventListener('fixture:navigate',fn);return ()=>window.removeEventListener('fixture:navigate',fn)};export const usePathname=()=>useSyncExternalStore(subscribe,()=>window.location.pathname);const router={replace:(href,options)=>{window.__replacements.push({href,options});window.history.replaceState({},'',href);window.dispatchEvent(new Event('fixture:navigate'));}};export const useRouter=()=>router;`);
await build({stdin:{contents:"export {useInitialMessagePreview} from './src/components/messages/use-initial-message-preview';export {clearMessageClientState} from './src/hooks/utils';",loader:'ts',resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'@/components/mailbox-provider':join(dir,'mailbox.ts'),'@/components/mail-search/mail-search-context':join(dir,'search.ts'),'next/navigation':join(dir,'navigation.ts')},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
let root;
function Harness(props){app.useInitialMessagePreview({config:{folder:'inbox',hrefPrefix:'/inbox',...props.config},readingLayout:props.layout??'bottom',offset:props.offset??0,unreadOnly:props.unreadOnly??false,selectedMessageId:props.selectedMessageId});return null;}
const response=(ids=['latest','older'])=>Response.json({messages:ids.map(id=>({id,mailboxId:window.__mailbox,read:false,direction:'inbound'})),total:ids.length,limit:25,offset:0});
async function mount(t,fetcher=async()=>response(),props={},path='/inbox'){
 app.clearMessageClientState();localStorage.clear();window.__replacements=[];window.__mailbox='box';window.__query='';window.history.replaceState({},'',path);desktop=props.desktop??true;
 document.body.innerHTML='<div id="root"></div>';t.mock.method(globalThis,'fetch',fetcher);root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));await act(async()=>root.render(React.createElement(Harness,props)));
}
const render=props=>act(async()=>root.render(React.createElement(Harness,props)));
const delay=()=>new Promise(resolve=>setTimeout(resolve,180));

test('desktop initially previews the latest email without an extra history step and preserves URL parameters',async t=>{
 const calls=[];await mount(t,async url=>{calls.push(String(url));return response();},{},'/inbox?view=mail');
 assert.deepEqual(window.__replacements,[{href:'/inbox/latest?view=mail',options:{scroll:false}}]);assert.equal(calls.length,1);
 assert(calls[0].includes('limit=25')&&calls[0].includes('group=thread'));
 await act(async()=>{window.dispatchEvent(new Event('mailflare:messages-changed'));await delay();});assert.equal(window.__replacements.length,1,'refresh never resets an existing preview');
});

test('right-hand reading layout and a label folder use the same initial preview',async t=>{
 let request;await mount(t,async url=>{request=String(url);return response();},{layout:'right',config:{folderId:'work',hrefPrefix:'/folders/work'}},'/folders/work');assert.equal(window.__replacements[0].href,'/folders/work/latest');assert(request.includes('folderId=work'));
});

test('a saved disabled preview overrides the preference hook first render before hydration finishes',async t=>{
 await mount(t,async()=>{localStorage.setItem('mailflare-reading-layout','off');return response();},{layout:'bottom'});
 assert.equal(window.location.pathname,'/inbox');assert.deepEqual(window.__replacements,[]);
});

test('mobile devices, disabled reading layout and drafts do not automatically open mail or fetch a preview list',async t=>{
 let requests=0;await mount(t,async()=>{requests++;return response();},{desktop:false});assert.equal(requests,0);assert.equal(window.location.pathname,'/inbox');
 desktop=true;await render({layout:'off'});assert.equal(requests,0);assert.equal(window.location.pathname,'/inbox');
 window.history.replaceState({},'','/drafts');await render({config:{folder:'drafts',hrefPrefix:'/drafts'}});assert.equal(requests,0);assert.deepEqual(window.__replacements,[]);
});

test('manually opened mail survives new arrivals and viewport changes',async t=>{
 let requests=0;await mount(t,async()=>{requests++;return response(['new-arrival']);},{selectedMessageId:'chosen'},'/inbox/chosen');
 desktop=false;await act(async()=>media.dispatchEvent(new Event('change')));desktop=true;await act(async()=>media.dispatchEvent(new Event('change')));
 await act(async()=>{window.dispatchEvent(new Event('mailflare:messages-changed'));await delay();});assert.equal(window.location.pathname,'/inbox/chosen');assert.equal(requests,0);assert.deepEqual(window.__replacements,[]);
});

test('empty folders and failed list requests retain the overview; a successful refresh can later fill the preview',async t=>{
 let fail=false,ids=[];await mount(t,async()=>fail?new Response(null,{status:503}):response(ids));assert.deepEqual(window.__replacements,[]);
 fail=true;await act(async()=>{window.dispatchEvent(new Event('mailflare:messages-changed'));await delay();});assert.deepEqual(window.__replacements,[]);
 fail=false;ids=['arrived'];await act(async()=>{window.dispatchEvent(new Event('mailflare:messages-changed'));await delay();});assert.equal(window.location.pathname,'/inbox/arrived');assert.equal(window.__replacements.length,1);
});

test('an old mailbox response cannot select an email after the selected mailbox changes',async t=>{
 let resolve;await mount(t,async url=>String(url).includes('mailboxId=box')?new Promise(r=>resolve=r):response(['other-latest']));
 window.__mailbox='other';await render({});assert.equal(window.location.pathname,'/inbox/other-latest');
 await act(async()=>resolve(response(['old-private'])));assert.equal(window.location.pathname,'/inbox/other-latest');assert.equal(window.__replacements.length,1);
});

test('enlarging a phone inbox to the desktop breakpoint fills its preview and retains filters',async t=>{
 let request;await mount(t,async url=>{request=String(url);return response(['matching']);},{desktop:false,unreadOnly:true,offset:25});window.__query='from:team@example.test';desktop=true;await act(async()=>media.dispatchEvent(new Event('change')));
 assert.equal(window.location.pathname,'/inbox/matching');const params=new URL('https://mailflare.test'+request).searchParams;assert.equal(params.get('q'),'from:team@example.test');assert.equal(params.get('read'),'unread');assert.equal(params.get('offset'),'25');
});
