import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','compose-error-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
await build({entryPoints:['src/components/compose/send-error.ts'],outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',tsconfig:'tsconfig.json',logLevel:'silent'});
const {composeSendError}=await import(pathToFileURL(join(dir,'app.mjs')));
const de=JSON.parse(readFileSync('public/locales/de.json','utf8'));
const t=(key,vars={})=>de[key].replace(/\{([^}]+)\}/g,(_,name)=>String(vars[name]??''));
test('missing attachments and concurrent edits produce German recoverable explanations',()=>{
 const text=composeSendError({code:'attachment_unavailable',filename:'Rechnung.pdf',error:'English provider error'},t);
 assert(text.includes('Rechnung.pdf'));assert(!text.includes('English'));assert.equal(composeSendError({code:'draft_changed'},t),de['compose.error.draftChanged']);
});
test('ambiguous delivery errors explain that resending requires checking the outcome',()=>{
 assert.equal(composeSendError({code:'delivery_unknown',error:'English provider error'},t),de['compose.error.deliveryUnknown']);
 assert.equal(composeSendError({code:'delivery_status_pending',error:'English provider error'},t),de['compose.error.deliveryStatusPending']);
});
test('structured validation payloads and absent bodies never become React children',()=>{
 for(const value of [{error:{fieldErrors:{to:['Invalid']}}},null,{},'proxy error'])assert.equal(composeSendError(value,t),de['compose.error.sendFailed']);
});
test('HTTP status, Cloudflare Ray ID and validation details are surfaced when response context is supplied',()=>{
 assert.equal(composeSendError(null,t,{status:403,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendFailed']} (HTTP 403, Ray a5e2e7ef1e481496). ${de['compose.error.sendRetry']}`);
 assert.equal(composeSendError(null,t,{status:502,rayId:'invalid ray!'}),`${de['compose.error.sendFailed']} (HTTP 502). ${de['compose.error.sendRetry']}`);
 assert.equal(composeSendError({error:{fieldErrors:{to:['At least one recipient is required']}}},t,{status:400}),`${de['compose.error.sendFailed']}: At least one recipient is required`);
 assert.equal(composeSendError({error:'Mailbox not found'},t,{status:403,rayId:'a5e2e7ef1e481496-FRA'}),'Mailbox not found');
});
test('a message that is too large and a lost sign-in are said in the interface language with what to do',()=>{
 assert.equal(composeSendError({error:'Request body is too large'},t,{status:413}),de['compose.error.sendTooLarge']);
 assert.equal(composeSendError(null,t,{status:413,rayId:'a5e2e7ef1e481496-FRA'}),de['compose.error.sendTooLarge'],'also when a proxy in front refused it');
 assert.equal(composeSendError({error:'Unauthorized'},t,{status:401}),de['compose.error.sendSignedOut']);
});
