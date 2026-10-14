import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-avatar-crop-'));after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export {getAvatarCrop} from './src/lib/avatar-upload-client.ts';export {getOptimizedAvatarFiles,storeAvatarImages,deleteAvatarImages,getAvatarImageResponse} from './src/lib/avatar-images.ts';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
test('crop stays within portrait/landscape bounds while dragging and zooming',()=>{
 for(const [w,h] of [[100,200],[200,100],[100,100]])for(const zoom of [0,1,2,3,4])for(const x of [-1,0,.5,1,2])for(const y of [-1,0,.5,1,2]){const crop=app.getAvatarCrop(w,h,zoom,x,y);assert(crop.x>=0&&crop.y>=0&&crop.x+crop.size<=w&&crop.y+crop.size<=h);}
 assert.equal(app.getAvatarCrop(100,200,1,.5,0).y,0);
});
test('uncropped source remains available privately; legacy avatars fall back and deletion removes all variants',async()=>{
 const map=new Map();const bucket={put:async(key,body)=>map.set(key,{body,httpMetadata:{contentType:'image/webp'},httpEtag:'etag-'+key}),get:async key=>map.get(key)??null,delete:async keys=>{for(const key of typeof keys==='string'?[keys]:keys)map.delete(key);}};
 const file=content=>new File([content],'avatar.webp',{type:'image/webp'});
 await app.storeAvatarImages(bucket,'avatar',file('crop'),file('preview'),file('source'));
 let response=await app.getAvatarImageResponse(new Request('https://mail.test/avatar?variant=original'),bucket,'avatar');assert.equal(await response.text(),'source');assert.match(response.headers.get('Cache-Control'),/^private/);
 await app.storeAvatarImages(bucket,'avatar',file('legacy'),file('preview'));response=await app.getAvatarImageResponse(new Request('https://mail.test/avatar?variant=original'),bucket,'avatar');assert.equal(await response.text(),'legacy');
 await app.deleteAvatarImages(bucket,'avatar');assert.equal(map.size,0);
 const form=new FormData();form.set('file',file('crop'));form.set('preview',file('preview'));form.set('original',new File(['bad'],'image.jpg',{type:'image/jpeg'}));assert.equal(app.getOptimizedAvatarFiles(form),null);
});


test('avatar browser caching is private, varies across account credentials and preserves etag revalidation',async()=>{
 const bucket={get:async()=>({body:'image',httpMetadata:{contentType:'image/webp'},httpEtag:'"avatar-v1"'})};
 const response=await app.getAvatarImageResponse(new Request('https://mail.test/api/profile/avatar'),bucket,'avatar');assert.equal(response.headers.get('Cache-Control'),'private, max-age=300');assert.equal(response.headers.get('Vary'),'Cookie, Authorization');
 const unchanged=await app.getAvatarImageResponse(new Request('https://mail.test/api/profile/avatar',{headers:{'If-None-Match':'"avatar-v1"'}}),bucket,'avatar');assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
 const versioned=await app.getAvatarImageResponse(new Request('https://mail.test/api/profile/avatar?v=new-photo'),bucket,'avatar');assert.equal(versioned.headers.get('Cache-Control'),'private, max-age=31536000, immutable');assert.equal(versioned.headers.get('Vary'),'Cookie, Authorization');
});
