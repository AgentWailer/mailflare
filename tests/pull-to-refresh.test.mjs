import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','TouchEvent'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
for(const key of ['requestAnimationFrame','cancelAnimationFrame'])globalThis[key]=dom.window[key].bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-pull-test-'));after(()=>{rmSync(dir,{recursive:true,force:true});dom.window.close();});
await build({stdin:{contents:`export {usePullToRefresh} from './src/components/messages/use-pull-to-refresh';export {PullRefreshList} from './src/components/messages/pull-refresh-list';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
let current,root;
function Screen(props){current=app.usePullToRefresh(props);return React.createElement('div',{ref:current.scrollRef},React.createElement('button',null,'Button'));}
async function mount(t,props={}){document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Screen,{enabled:true,busy:false,onRefresh:async()=>{},...props})));t.after(async()=>act(async()=>root.unmount()));}
const point=(x,y)=>({clientX:x,clientY:y,identifier:1});
async function touch(type,points,target=current.scrollRef.current){let event;await act(async()=>{event=new TouchEvent(type,{bubbles:true,cancelable:true,touches:points});target.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,20));});return event;}
async function pull(x=0,y=140){await touch('touchstart',[point(50,50)]);const move=await touch('touchmove',[point(50+x,50+y)]);return move;}

test('downward pull from the top refreshes on release and locks duplicate pulls until completion',async t=>{let calls=0,release;await mount(t,{onRefresh:()=>{calls++;return new Promise(resolve=>release=resolve);}});const move=await pull();assert(move.defaultPrevented);assert(current.ready);await touch('touchend',[]);assert.equal(calls,1);assert(current.refreshing);await pull();await touch('touchend',[]);assert.equal(calls,1);await act(async()=>{release();await new Promise(resolve=>setTimeout(resolve,350));});await touch('touchcancel',[]);assert.equal(current.distance,0);assert.equal(current.refreshing,false);});
test('short and cancelled pulls never refresh',async t=>{let calls=0;await mount(t,{onRefresh:async()=>{calls++;}});await pull(0,60);assert(!current.ready);await touch('touchend',[]);assert.equal(calls,0);await pull();await touch('touchcancel',[]);await touch('touchend',[]);assert.equal(calls,0);assert.equal(current.distance,0);});
test('normal scrolling and horizontal swipes remain native',async t=>{let calls=0;await mount(t,{onRefresh:async()=>{calls++;}});current.scrollRef.current.scrollTop=50;assert.equal((await pull()).defaultPrevented,false);await touch('touchend',[]);current.scrollRef.current.scrollTop=0;assert.equal((await pull(150,15)).defaultPrevented,false);await touch('touchend',[]);assert.equal((await pull(0,-80)).defaultPrevented,false);await touch('touchend',[]);assert.equal(calls,0);});
test('multitouch, controls, disabled desktop and an existing refresh do not trigger another request',async t=>{let calls=0;await mount(t,{onRefresh:async()=>{calls++;}});await pull();await touch('touchstart',[point(50,180),point(70,180)]);await touch('touchend',[point(70,180)]);await touch('touchend',[]);assert.equal(calls,0);const button=current.scrollRef.current.querySelector('button');await touch('touchstart',[point(50,50)],button);await touch('touchmove',[point(50,190)],button);await touch('touchend',[],button);assert.equal(calls,0);await act(async()=>root.render(React.createElement(Screen,{enabled:false,busy:false,onRefresh:async()=>{calls++;}})));await pull();await touch('touchend',[]);assert.equal(calls,0);await act(async()=>root.render(React.createElement(Screen,{enabled:true,busy:true,onRefresh:async()=>{calls++;}})));await pull();await touch('touchend',[]);assert.equal(calls,0);});
test('refresh failure releases the gesture for a subsequent retry',async t=>{let calls=0;await mount(t,{onRefresh:async()=>{calls++;throw Error('offline');}});await pull();await touch('touchend',[]);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350));});assert.equal(current.refreshing,false);assert.equal(current.distance,0);await pull();await touch('touchend',[]);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350));});assert.equal(calls,2);});


test('pull animation leaves message rows mounted without rerendering them for each move',async t=>{
 await mount(t);let renders=0;function Row(){renders++;return React.createElement('span',{'data-row':'stable'},'Mail row');}
 await act(async()=>root.render(React.createElement(app.PullRefreshList,{enabled:true,busy:false,onRefresh:async()=>{}},React.createElement(Row))));
 const list=document.querySelector('.mail-mobile-list-scroll'),row=document.querySelector('[data-row]');await touch('touchstart',[point(50,50)],list);
 for(let i=1;i<=8;i++)await touch('touchmove',[point(50,50+i*15)],list);
 assert.equal(renders,1,'gesture updates only the animated wrappers');assert.equal(document.querySelector('[data-row]'),row);
 await touch('touchcancel',[],list);assert.equal(renders,1);
});
