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
test('the initial and its colour stand in until the picture is shown, then give way to a white ground',async t=>{
 document.body.innerHTML='<div id="root"></div>';const root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 const render=async props=>act(async()=>root.render(React.createElement(SenderAvatar,props)));
 const avatar=()=>document.querySelector('#root > span'),image=()=>document.querySelector('img');
 const fire=type=>act(async()=>image().dispatchEvent(new dom.window.Event(type)));
 // A sender without bundled artwork gets the logo found for its domain, often a shape on a transparent ground.
 // Invented domains; reserved ones such as .example get no logo at all. Nothing is fetched here.
 const shop={mailboxId:'box',address:'Hejfish <news@fischladen-beispiel.de>',name:'Hejfish',hasAvatar:false};
 await render(shop);
 assert(image().getAttribute('src').startsWith('/api/contacts/logo?'));
 assert.equal(avatar().textContent,'H','the initial is the placeholder while the logo loads');
 const placeholder=avatar().style.backgroundColor;assert(placeholder&&placeholder!=='rgb(255, 255, 255)');
 await fire('load');
 assert.equal(avatar().textContent,'','no letter is left behind a logo to show through it');
 assert.equal(avatar().style.backgroundColor,'rgb(255, 255, 255)','nor the placeholder colour');
 assert(avatar().hasAttribute('data-avatar-picture'));
 // The next sender starts with its own initial again; nothing of the previous picture's state is kept.
 await render({...shop,address:'Vorwerk <service@staubsauger-beispiel.de>',name:'Vorwerk'});
 assert.equal(avatar().textContent,'V');assert.notEqual(avatar().style.backgroundColor,'rgb(255, 255, 255)');
 await fire('load');assert.equal(avatar().textContent,'');
 // A logo that cannot be loaded leaves the initial and its colour.
 await render({...shop,address:'Other <hello@anderes-beispiel.de>',name:'Other'});
 await fire('error');assert.equal(image(),null);assert.equal(avatar().textContent,'O');assert.notEqual(avatar().style.backgroundColor,'rgb(255, 255, 255)');assert(!avatar().hasAttribute('data-avatar-picture'));
 // A contact photo behaves the same, from its first (blurred) picture on.
 globalThis.Image=dom.window.Image;t.after(()=>{delete globalThis.Image;});
 await render({...shop,address:'Photo <friend@freunde-beispiel.de>',name:'Photo',hasAvatar:true});
 assert(image().getAttribute('src').startsWith('/api/contacts/avatar?'));assert.equal(avatar().textContent,'P');
 await fire('load');assert.equal(avatar().textContent,'');assert.equal(avatar().style.backgroundColor,'rgb(255, 255, 255)');
 // A photo that fails altogether hands over to the domain's logo, which has not loaded yet: the initial is back.
 await render({...shop,address:'Gone <friend@verloren-beispiel.de>',name:'Gone',hasAvatar:true});
 await fire('error');await fire('error');
 assert(image().getAttribute('src').startsWith('/api/contacts/logo?'));assert.equal(avatar().textContent,'G');
 await fire('load');assert.equal(avatar().textContent,'');
});
