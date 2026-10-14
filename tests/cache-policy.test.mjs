import assert from 'node:assert/strict';
import test from 'node:test';
import {applyAppCachePolicy} from '../src/lib/http/cache-policy.ts';
test('cookie-personalized HTML and login redirects are not stored in shared caches',async()=>{
 for(const [path,type] of [['/','text/html'],['/inbox','text/html'],['/inbox?x=1','text/x-component'],['/login','']]){
  const original=new Response('private content',{headers:{'Content-Type':type,'Cache-Control':'public,max-age=3600'}});const response=applyAppCachePolicy(new Request('https://mail.test'+path,{headers:{Cookie:'ep_session=fake'}}),original);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(await response.text(),'private content');
 }
});
test('private mailbox JSON gets no-store, while explicit private photo caching is retained',()=>{
 const data=applyAppCachePolicy(new Request('https://mail.test/api/messages'),Response.json({messages:[]}));assert.equal(data.headers.get('Cache-Control'),'private, no-store');
 const image=new Response('image',{headers:{'Content-Type':'image/webp','Cache-Control':'private, max-age=300',Vary:'Cookie, Authorization'}});assert.equal(applyAppCachePolicy(new Request('https://mail.test/api/profile/avatar'),image),image);
});
test('fingerprinted static assets retain their public immutable policy',()=>{
 const asset=new Response('javascript',{headers:{'Content-Type':'text/javascript','Cache-Control':'public,max-age=31536000,immutable'}});assert.equal(applyAppCachePolicy(new Request('https://mail.test/_next/static/chunks/app-hash.js'),asset),asset);
});
test('private response policy preserves status, location and separate session cookies',()=>{
 const headers=new Headers({Location:'/inbox'});headers.append('Set-Cookie','ep_session=fake; HttpOnly');headers.append('Set-Cookie','ep_accounts=fake; HttpOnly');
 const response=applyAppCachePolicy(new Request('https://mail.test/'),new Response(null,{status:307,headers}));assert.equal(response.status,307);assert.equal(response.headers.get('Location'),'/inbox');assert.equal(response.headers.getSetCookie().length,2);
});
