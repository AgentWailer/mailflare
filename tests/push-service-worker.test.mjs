import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function worker({ badgeFails=false, supportsBadge=true, windows=[] }={}) {
 const handlers=new Map(), notifications=[], badges=[], opened=[];
 const navigator=supportsBadge ? {
  setAppBadge:async n=>{badges.push(n);if(badgeFails)throw new Error('Permission denied');},
  clearAppBadge:async()=>badges.push(0),
 } : {};
 const self={navigator,skipWaiting:async()=>{},location:{origin:'https://mailflare.test'},addEventListener:(name,fn)=>handlers.set(name,fn),registration:{showNotification:async(title,options)=>notifications.push({title,...options})},clients:{claim:async()=>{},matchAll:async()=>windows,openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL});
 async function dispatch(name,event){let work;handlers.get(name)({...event,waitUntil:p=>{work=p;}});await work;}
 const push=payload=>dispatch('push',{data:{json:()=>payload}});
 return {push,dispatch,notifications,badges,opened};
}

test('iOS push always displays a notification and updates the app badge even with a visible app',async()=>{
 const w=worker({windows:[{visibilityState:'visible'}]});
 await w.push({title:'Invoice',body:'From Sam',unreadCount:7,url:'/inbox/message',tag:'message'});
 assert.deepEqual(w.badges,[7]);assert.equal(w.notifications.length,1);
 assert.equal(w.notifications[0].title,'Invoice');assert.equal(w.notifications[0].data.url,'/inbox/message');
});

test('zero unread clears the badge; missing/invalid counts leave the previous badge alone',async()=>{
 const w=worker();
 for(const count of [0,undefined,-1,1.5,'4'])await w.push({unreadCount:count});
 assert.deepEqual(w.badges,[0]);assert.equal(w.notifications.length,5);
});

test('a denied or unsupported badge API does not prevent push delivery',async()=>{
 for(const options of [{badgeFails:true},{supportsBadge:false}]){
  const w=worker(options);await w.push({unreadCount:3});assert.equal(w.notifications.length,1);
 }
});

test('malformed or empty pushes still show a generic notification',async()=>{
 const w=worker();await w.dispatch('push',{data:{json:()=>{throw new Error('Bad JSON');}}});await w.dispatch('push',{});
 assert.equal(w.notifications.length,2);assert.equal(w.notifications[0].title,'New email');assert.deepEqual(w.badges,[]);
});

test('notification clicks navigate a current app window to the email, retaining the unread badge',async()=>{
 const actions=[];const w=worker({windows:[{url:'https://mailflare.test/inbox',focus:async()=>actions.push('focus'),navigate:async url=>actions.push(url)}]});
 await w.dispatch('notificationclick',{notification:{data:{url:'/inbox/message'},close:()=>actions.push('close')}});
 assert.deepEqual(actions,['close','focus','https://mailflare.test/inbox/message']);assert.deepEqual(w.badges,[]);
});

test('notification URLs cannot escape the installation origin',async()=>{
 const w=worker({windows:[{url:'https://mailflare.test.attacker.test',focus:async()=>assert.fail('wrong origin selected')}]});
 await w.dispatch('notificationclick',{notification:{data:{url:'https://attacker.test'},close(){}}});
 assert.deepEqual(w.opened,['https://mailflare.test/inbox']);
});


test('mail notification keeps sender heading and subject/snippet line break from the encrypted payload',async()=>{
 const w=worker();await w.push({title:'Sam Example',body:'Invoice October\nYour payment has arrived.',url:'/inbox/message',tag:'message',unreadCount:2});
 assert.equal(w.notifications[0].title,'Sam Example');assert.equal(w.notifications[0].body,'Invoice October\nYour payment has arrived.');assert.equal(w.notifications[0].tag,'message');
});
