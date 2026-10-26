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
test('personalized APIs override accidental public policies and session writes never enter a cache',async()=>{
 for(const path of ['/api/messages','/api/auth/me','/api/mailboxes','/api/settings/mcp-oauth']){
  for(const actor of ['owner-a','owner-b']){
   const response=applyAppCachePolicy(new Request('https://mail.test'+path,{headers:{Authorization:'Bearer '+actor,Cookie:'ep_session='+actor}}),Response.json({owner:actor},{headers:{'Cache-Control':'public, max-age=3600, s-maxage=86400'}}));
   assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal((await response.json()).owner,actor);
  }
 }
 const response=applyAppCachePolicy(new Request('https://mail.test/api/branding/icon'),new Response('image',{headers:{'Content-Type':'image/png','Cache-Control':'public, max-age=3600','Set-Cookie':'ep_session=synthetic; HttpOnly'}}));assert.equal(response.headers.get('Cache-Control'),'private, no-store');
});
test('private browser images vary by authentication and missing hashed assets are never immutable',()=>{
 const image=applyAppCachePolicy(new Request('https://mail.test/api/contacts/logo'),new Response('png',{headers:{'Cache-Control':'private, max-age=300','Content-Type':'image/png',ETag:'"image-v1"'}}));assert.equal(image.headers.get('Cache-Control'),'private, max-age=300');assert.match(image.headers.get('Vary'),/Cookie, Authorization/);assert.equal(image.headers.get('ETag'),'"image-v1"');
 const missing=applyAppCachePolicy(new Request('https://mail.test/_next/static/missing.js'),new Response('Not found',{status:404,headers:{'Cache-Control':'public, max-age=31536000, immutable'}}));assert.equal(missing.headers.get('Cache-Control'),'private, no-store');
});
