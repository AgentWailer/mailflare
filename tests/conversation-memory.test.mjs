import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test/inbox',pretendToBeVisual:true});
for(const key of ['window','document','localStorage','Event','CustomEvent','HTMLElement','navigator'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','conversation-memory-test-'));after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
writeFileSync(join(dir,'avatar.tsx'),'export const ContactAvatar=()=>null;');
writeFileSync(join(dir,'actions.tsx'),`export const ThreadMessageActions=({message,starOnly})=><button data-actions data-ready={!starOnly} data-reply-body={message.textBody??''}>Reply</button>;`);
writeFileSync(join(dir,'renderer.tsx'),`export const EmailHtmlRenderer=({html})=><div>{html}</div>;`);
await build({stdin:{contents:`export * from './src/lib/messages/detail-cache';export {ConversationMessageCard,ConversationThread} from './src/components/messages/conversation-thread';export {LanguageProvider} from './src/components/language-provider';export {useMessageThread} from './src/components/messages/use-message-thread';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'@/components/contacts/contact-avatar':join(dir,'avatar.tsx')},plugins:[{name:'presentation-stubs',setup(b){b.onResolve({filter:/^\.\/thread-message-actions$/},()=>({path:join(dir,'actions.tsx')}));b.onResolve({filter:/^\.\/email-html-renderer$/},()=>({path:join(dir,'renderer.tsx')}));}}],logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs'))),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const summary={id:'mail',userId:'owner',mailboxId:'box',direction:'inbound',read:true,starred:false,fromAddr:'sender@example.test',toAddr:'owner@example.test',subject:'Subject',snippet:'Preview',createdAt:'2026-10-20T12:00:00Z',status:'received',threadId:'thread',textBody:null,htmlBody:null,bodyLoaded:false,attachments:[]};
async function mount(t,fetcher,props={}){
 localStorage.clear();app.clearMessageDetailCache();document.body.innerHTML='<div id="root"></div>';t.mock.method(globalThis,'fetch',fetcher);const root=createRoot(document.getElementById('root'));t.after(async()=>act(async()=>root.unmount()));
 const render=async message=>act(async()=>root.render(React.createElement(app.LanguageProvider,{},React.createElement(app.ConversationMessageCard,{mailboxId:'box',message,...props}))));await render(summary);return {root,render};
}
const open=()=>document.querySelector('button[aria-expanded]');
test('collapsed headers load no bodies; expansion requests one body and enables replies with that original content',async t=>{
 let resolve,calls=0;await mount(t,()=>{calls++;return new Promise(r=>resolve=r);});assert.equal(calls,0);await act(async()=>open().click());assert.equal(calls,1);assert(document.querySelector('[role=status]'));assert.equal(document.querySelector('[data-actions]').dataset.ready,'false');
 await act(async()=>resolve(Response.json({message:{id:'mail'},body:{textBody:'Original full reply text',htmlBody:null}})));assert(document.body.textContent.includes('Original full reply text'));assert.equal(document.querySelector('[data-actions]').dataset.replyBody,'Original full reply text');assert.equal(document.querySelector('[data-actions]').dataset.ready,'true');await act(async()=>open().click());await act(async()=>open().click());assert.equal(calls,1,'reopening uses the cached body');
});
test('failed lazy bodies can be retried without falsely displaying an empty mail',async t=>{
 let fail=true,calls=0;await mount(t,async()=>{calls++;return fail?new Response('{}',{status:404}):Response.json({message:{id:'mail'},body:{textBody:'Recovered content',htmlBody:null}});});await act(async()=>open().click());assert(document.querySelector('[role=alert]'));fail=false;await act(async()=>document.querySelector('[role=alert] button').click());assert.equal(calls,2);assert(document.body.textContent.includes('Recovered content'));
});
test('legacy already-loaded bodies need no fetch, and external read changes update collapsed previews',async t=>{
 let calls=0;const {render}=await mount(t,async url=>{if(String(url).endsWith('/api/messages/mail'))calls++;return Response.json({});});const legacy={...summary,bodyLoaded:undefined,textBody:'Legacy body',read:false};await render(legacy);assert(document.body.textContent.includes('Preview'));await act(async()=>open().click());assert(document.body.textContent.includes('Legacy body'));assert.equal(calls,0);await act(async()=>open().click());await render({...legacy,read:true});assert(!document.querySelector('span.block.truncate').className.includes('font-semibold'));
});
test('the detail cache evicts old entries by count and keeps recently viewed messages',async t=>{
 app.clearMessageDetailCache();localStorage.clear();let calls=0;t.mock.method(globalThis,'fetch',async url=>{calls++;const id=String(url).split('/').at(-1);return Response.json({message:{id},body:{textBody:'Content '+id,htmlBody:null}});});
 for(let i=0;i<32;i++)await app.fetchCachedMessageDetail('m'+i);assert(app.getCachedMessageDetail('m0'));await app.fetchCachedMessageDetail('m32');assert(app.getCachedMessageDetail('m0'));assert.equal(app.getCachedMessageDetail('m1'),undefined);await app.fetchCachedMessageDetail('m1');assert.equal(calls,34);app.clearMessageDetailCache();assert.equal(app.getCachedMessageDetail('m0'),undefined);
});
test('the detail cache evicts by bytes before the count cap and does not retain oversized selected messages',async t=>{
 app.clearMessageDetailCache();localStorage.clear();t.mock.method(globalThis,'fetch',async url=>Response.json({message:{id:String(url).split('/').at(-1)},body:{htmlBody:'x'.repeat(3*1024*1024),textBody:null}}));
 for(let i=0;i<3;i++)await app.fetchCachedMessageDetail('large'+i);assert.equal(app.getCachedMessageDetail('large0'),undefined);assert(app.getCachedMessageDetail('large2'));
 app.primeMessageDetail({id:'oversized',htmlBody:'x'.repeat(9*1024*1024)});assert.equal(app.getCachedMessageDetail('oversized'),undefined);assert(app.getCachedMessageDetail('large2'));
});

test('conversation loading explicitly requests headers so legacy compatibility never loads bodies in the new app',async t=>{
 const urls=[];const {root}=await mount(t,async url=>{urls.push(String(url));return Response.json({threadId:'thread',messages:[summary]});});
 function Harness(){const thread=app.useMessageThread('mail','thread');return React.createElement('span',null,String(thread.messages.length));}
 await act(async()=>root.render(React.createElement(Harness)));assert.equal(urls.length,1);assert.equal(new URL(urls[0],'https://mailflare.test').searchParams.get('view'),'headers');assert.equal(document.body.textContent,'1');
});
