import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory=mkdtempSync(join(process.cwd(),'node_modules','mailflare-push-client-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
writeFileSync(join(directory,'auth.mjs'),'export const authFetch=(url,init)=>globalThis.fetch(url,init);');
await build({entryPoints:['src/lib/push/client.ts'],outfile:join(directory,'client.mjs'),bundle:true,format:'esm',platform:'node',tsconfig:'tsconfig.json',alias:{'@/lib/auth/client':join(directory,'auth.mjs')},logLevel:'silent'});
const client=await import(pathToFileURL(join(directory,'client.mjs')).href);
const publicKey=Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');

function fixture(t,{subscription=null,active=true,saveFails=false}={}){
 const events=[];let sub=subscription;
 const registration={active:active?{}:null,pushManager:{getSubscription:async()=>sub,subscribe:async options=>{events.push('subscribe');sub=makeSubscription(options.applicationServerKey);return sub;}}};
 const notification={permission:'granted',requestPermission:async()=>{events.push('permission');return 'granted';}};
 const navigator={userAgent:'iPhone',platform:'iPhone',maxTouchPoints:1,standalone:false,serviceWorker:{register:async()=>registration,getRegistration:async()=>registration,ready:Promise.resolve({...registration,active:{}})}};
 const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:navigator});
 Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true,Notification:notification,PushManager:function(){},matchMedia:()=>({matches:navigator.standalone}),dispatchEvent:()=>true}});
 Object.defineProperty(globalThis,'Notification',{configurable:true,value:notification});
 t.after(()=>{delete globalThis.window;delete globalThis.Notification;Object.defineProperty(globalThis,'navigator',originalNavigator);});
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  events.push(String(url));
  if(String(url).endsWith('/config'))return Response.json({enabled:true,publicKey});
  if(saveFails&&init?.method==='POST'&&String(url).endsWith('/subscriptions'))return new Response('Database unavailable',{status:503});
  return Response.json({ok:true});
 });
 function makeSubscription(key=Buffer.from(publicKey,'base64url').buffer){return {endpoint:'https://web.push.apple.com/test',options:{applicationServerKey:key},toJSON:()=>({endpoint:'https://web.push.apple.com/test',keys:{p256dh:'key',auth:'auth'}}),unsubscribe:async()=>{events.push('unsubscribe');return true;}};}
 return {events,navigator,registration,makeSubscription};
}

test('permission is requested directly before network awaits, and a new Apple subscription is saved',async t=>{
 const f=fixture(t);await client.enablePushNotifications();
 assert.equal(f.events[0],'permission');assert.ok(f.events.indexOf('subscribe')<f.events.indexOf('/api/push/subscriptions'));
});

test('registration waits for activation on a first installation',async t=>{
 const f=fixture(t,{active:false});const registration=await client.registerMailflareServiceWorker();assert.ok(registration.active);assert.notEqual(registration,f.registration);
});

test('a rotated application server key replaces the obsolete subscription',async t=>{
 const old={options:{applicationServerKey:new ArrayBuffer(65)},unsubscribe:async()=>{events.push('unsubscribe');return true;}};
 const f=fixture(t,{subscription:old});const events=f.events;
 await client.enablePushNotifications();assert.ok(events.indexOf('unsubscribe')<events.indexOf('subscribe'));
});

test('a failed subscription save rolls back the browser subscription',async t=>{
 const f=fixture(t,{saveFails:true});await assert.rejects(client.enablePushNotifications());assert.ok(f.events.includes('unsubscribe'));
});

test('an existing subscription must be saved to the current session before reporting it active',async t=>{
 const key=Uint8Array.from(Buffer.from(publicKey,'base64url')).buffer;
 const sub={options:{applicationServerKey:key},toJSON:()=>({endpoint:'https://web.push.apple.com/test',keys:{p256dh:'key',auth:'auth'}})};
 fixture(t,{subscription:sub});const state=await client.getPushState();assert.equal(state.subscribed,true);assert.equal(state.syncFailed,false);
});

test('a lost server binding remains retryable rather than falsely showing notifications enabled',async t=>{
 const key=Uint8Array.from(Buffer.from(publicKey,'base64url')).buffer;
 const sub={options:{applicationServerKey:key},toJSON:()=>({endpoint:'https://web.push.apple.com/test',keys:{p256dh:'key',auth:'auth'}})};
 fixture(t,{subscription:sub,saveFails:true});const state=await client.getPushState();assert.equal(state.supported,true);assert.equal(state.configured,true);assert.equal(state.subscribed,false);assert.equal(state.syncFailed,true);
});

test('iPhone Safari explains installation while the Home Screen app can enable push',t=>{
 const f=fixture(t);assert.equal(client.needsHomeScreenInstallation(),true);f.navigator.standalone=true;assert.equal(client.needsHomeScreenInstallation(),false);
});
