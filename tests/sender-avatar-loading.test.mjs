import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir=mkdtempSync(join(process.cwd(),'node_modules','sender-avatar-test-'));
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','Event','CustomEvent','HTMLElement','navigator'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
await build({stdin:{contents:`export {SenderAvatar} from './src/components/messages/sender-avatar'; export {CONTACT_AVATAR_CHANGED_EVENT} from './src/lib/contacts/avatar-client';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const {SenderAvatar,CONTACT_AVATAR_CHANGED_EVENT}=await import(pathToFileURL(join(dir,'app.mjs'))),React=await import('react'),{act}=React,{renderToStaticMarkup}=await import('react-dom/server'),{createRoot}=await import('react-dom/client');
const apple={mailboxId:'box',address:'Apple <receipt@apple.com>',name:'Apple',hasAvatar:false,priority:true};
test('a known sender logo is present in the initial render at its exact reusable URL',()=>{
 const markup=renderToStaticMarkup(React.createElement(SenderAvatar,apple));
 assert.match(markup,/<img/);assert.match(markup,/src="\/sender-logos\/apple.svg"/);assert.match(markup,/loading="eager"/);assert.match(markup,/fetchPriority="high"/);assert(!markup.includes('blur('));assert(!markup.includes('variant='));assert(!markup.includes('/api/contacts/avatar'));
});
test('managed photos, edits, failed photos and changing senders preserve correct image priority',async t=>{
 document.body.innerHTML='<div id="root"></div>';const root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 const render=async props=>act(async()=>root.render(React.createElement(SenderAvatar,props)));
 const image=()=>document.querySelector('img');
 await render(apple);assert.equal(image().getAttribute('src'),'/sender-logos/apple.svg');
 await render({...apple,hasAvatar:true});assert(image().getAttribute('src').startsWith('/api/contacts/avatar?'));assert(!image().getAttribute('src').includes('variant='));
 await act(async()=>image().dispatchEvent(new dom.window.Event('error')));assert.equal(image().getAttribute('src'),'/sender-logos/apple.svg');
 await act(async()=>window.dispatchEvent(new CustomEvent(CONTACT_AVATAR_CHANGED_EVENT,{detail:{email:'receipt@apple.com',hasAvatar:true}})));assert(image().getAttribute('src').includes('&v='));
 await act(async()=>window.dispatchEvent(new CustomEvent(CONTACT_AVATAR_CHANGED_EVENT,{detail:{email:'receipt@apple.com',hasAvatar:false}})));assert.equal(image().getAttribute('src'),'/sender-logos/apple.svg');
 await act(async()=>image().dispatchEvent(new dom.window.Event('error')));assert.equal(image(),null);
 await render({...apple,address:'support@cloudflare.com',name:'Cloudflare'});assert.equal(image().getAttribute('src'),'/sender-logos/cloudflare.svg');
 await render({...apple,managedAvatarUrl:'/api/mailboxes/box/avatar'});assert.equal(image().getAttribute('src'),'/api/mailboxes/box/avatar');
 await act(async()=>image().dispatchEvent(new dom.window.Event('error')));assert.equal(image(),null,'an explicit mailbox avatar falls back to initials');
});
test('list logos use the identical full image URL without a blurred preview',()=>{
 const markup=renderToStaticMarkup(React.createElement(SenderAvatar,{...apple,priority:false}));assert.match(markup,/src="\/sender-logos\/apple.svg"/);assert(!markup.includes('variant='));assert(!markup.includes('blur('));assert.match(markup,/loading="lazy"/);
});
