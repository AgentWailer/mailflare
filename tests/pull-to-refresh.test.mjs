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
await build({stdin:{contents:`export {usePullToRefresh} from './src/components/messages/use-pull-to-refresh';export {PullRefreshList} from './src/components/messages/pull-refresh-list';export {SwipeableRow} from './src/components/messages/swipeable-row';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
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

test('normal scrolling has no blocking move listener; only an eligible top pull attaches one',async t=>{
 await mount(t);const list=current.scrollRef.current,adds=[],removes=[];const add=list.addEventListener.bind(list),remove=list.removeEventListener.bind(list);
 t.mock.method(list,'addEventListener',(name,listener,options)=>{adds.push({name,options});return add(name,listener,options);});t.mock.method(list,'removeEventListener',(name,listener)=>{removes.push(name);return remove(name,listener);});
 list.scrollTop=50;await touch('touchstart',[point(50,50)]);assert.equal(adds.filter(e=>e.name==='touchmove').length,0);
 list.scrollTop=0;await touch('touchstart',[point(50,50)]);assert.equal(adds.filter(e=>e.name==='touchmove'&&e.options.passive===false).length,1);
 await touch('touchmove',[point(50,20)]);assert(removes.includes('touchmove'),'an upward scroll immediately drops the blocking listener');assert.equal((await touch('touchmove',[point(50,10)])).defaultPrevented,false);
 await touch('touchstart',[point(50,50)]);await touch('touchmove',[point(50,200)]);assert(current.ready);await touch('touchcancel',[]);assert.equal(current.distance,0);
});

test('high-frequency pull updates share one animation frame with the latest finger position',async t=>{
 const pending=new Map();let id=0;t.mock.method(globalThis,'requestAnimationFrame',callback=>{pending.set(++id,callback);return id;});t.mock.method(globalThis,'cancelAnimationFrame',key=>pending.delete(key));
 await mount(t);async function flush(){await act(async()=>{const callbacks=[...pending.values()];pending.clear();callbacks.forEach(callback=>callback(0));});}await flush();
 const list=current.scrollRef.current;await act(async()=>{
  list.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[point(50,50)]}));
  for(let y=70;y<=200;y+=10)list.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[point(50,y)]}));
 });
 assert.equal(pending.size,1);await flush();assert(current.ready);assert(Math.abs(current.distance-96*(1-Math.exp(-150/120)))<0.001);
 await act(async()=>list.dispatchEvent(new TouchEvent('touchcancel',{bubbles:true,touches:[]})));await flush();assert.equal(current.distance,0);
});


test('swipe updates coalesce per frame, resist long drags and commit without waiting for another frame',async t=>{
 const pending=new Map();let id=0;t.mock.method(globalThis,'requestAnimationFrame',callback=>{pending.set(++id,callback);return id;});t.mock.method(globalThis,'cancelAnimationFrame',key=>pending.delete(key));
 await mount(t);pending.clear();let commits=0;const Icon=()=>React.createElement('span');const action={label:'Archive',icon:Icon,className:'bg-green',onTrigger:()=>commits++};
 await act(async()=>root.render(React.createElement(app.SwipeableRow,{startAction:action,endAction:action},React.createElement('span',null,'Message'))));
 const row=document.querySelector('[style*="touch-action"]')??document.querySelector('.swipe-row-motion.relative');row.setPointerCapture=()=>{};
 function pointer(type,x,y=50){const event=new window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y});Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:'touch'}});row.dispatchEvent(event);}
 await act(async()=>{pointer('pointerdown',300);for(let x=280;x>=-200;x-=20)pointer('pointermove',x);});assert.equal(pending.size,1);assert.equal(commits,0);
 await act(async()=>{const callbacks=[...pending.values()];pending.clear();callbacks.forEach(callback=>callback(0));});const offset=Math.abs(Number(row.style.transform.match(/translate3d\(([-\d.]+)px/)[1]));assert(offset>88&&offset<152,'long swipes stretch with increasing resistance');
 await act(async()=>pointer('pointermove',-220));assert.equal(pending.size,1);await act(async()=>pointer('pointerup',-220));assert.equal(commits,1);assert.equal(pending.size,0);assert.equal(row.style.transform,'');
 const backdrop=document.querySelector('.swipe-row-motion.absolute');assert(backdrop,'the backdrop remains mounted for the return fade');assert.equal(backdrop.style.opacity,'0');
});
