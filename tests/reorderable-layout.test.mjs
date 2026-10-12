import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','label-layout-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
await build({entryPoints:['src/components/reorderable-list-utils.ts'],outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);

function browserGlobals(t,events,storage){for(const [name,value] of [['window',events],['localStorage',storage]]){const original=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else delete globalThis[name];});}}

test('releasing over the dragged label keeps its position instead of appending it',()=>{
 const layout={folders:['a','b','c']};assert.deepEqual(app.moveItem(layout,'b','folders','b'),layout);assert.deepEqual(app.moveItem(layout,'b','folders','c'),layout);assert.deepEqual(app.moveItem(layout,'b','folders',null),{folders:['a','c','b']});assert.deepEqual(layout,{folders:['a','b','c']});
});
test('saved orders retain valid labels, discard duplicates and deletions, and tolerate malformed preferences',()=>{
 const defaults={folders:['a','b','c','new']};assert.deepEqual(app.resolveLayout(defaults,{folders:['c','gone','a','c']}),{folders:['c','a','b','new']});
 for(const raw of ['broken','null','[]','{"folders":"invalid"}'])assert.deepEqual(app.resolveLayout(defaults,app.parseLayoutSnapshot(raw)),defaults);
});
test('layout saves publish updates and keep each mailbox and sibling group independent',t=>{
 const store=new Map(),events=new EventTarget();browserGlobals(t,events,{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)});let updates=0;const stop=app.subscribeLayoutChanges(()=>updates++);
 const root='mailbox:root',child='mailbox:children:parent',other='other:root';app.writeStorage(root,{folders:['b','a']});app.writeStorage(child,{folders:['x','y']});assert.equal(updates,2);assert.deepEqual(app.parseLayoutSnapshot(app.getLayoutSnapshot(root)),{folders:['b','a']});assert.equal(app.getLayoutSnapshot(other),'{}');assert.deepEqual(app.parseLayoutSnapshot(app.getLayoutSnapshot(child)),{folders:['x','y']});stop();app.writeStorage(root,{folders:['a','b']});assert.equal(updates,2);
});
test('unavailable local storage retains the order for the current session',t=>{
 browserGlobals(t,new EventTarget(),{getItem:()=>{throw Error('Unavailable');},setItem:()=>{throw Error('Full');}});app.writeStorage('private:labels',{folders:['b','a']});assert.deepEqual(app.parseLayoutSnapshot(app.getLayoutSnapshot('private:labels')),{folders:['b','a']});
});
