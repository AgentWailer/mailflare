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
test('HTTP status and Cloudflare Ray ID are kept, and each failure says what to do next',()=>{
 // A refusal changed nothing: trying again is safe.
 assert.equal(composeSendError(null,t,{status:403,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendFailed']} (HTTP 403, Ray a5e2e7ef1e481496). ${de['compose.error.sendRetry']}`);
 // A gateway that gave up may have done so after the message was accepted: look before sending twice.
 for(const status of [500,502,504,524])assert.equal(composeSendError(null,t,{status,rayId:'invalid ray!'}),`${de['compose.error.sendFailed']} (HTTP ${status}). ${de['compose.error.sendCheckFirst']}`);
 assert.equal(composeSendError({error:'Queue write failed.'},t,{status:500}),`${de['compose.error.sendFailed']}: Queue write failed. ${de['compose.error.sendCheckFirst']}`);
 assert.equal(composeSendError({error:{fieldErrors:{subject:['Subject is too long']}}},t,{status:400}),`${de['compose.error.sendFailed']}: Subject is too long. ${de['compose.error.sendRetry']}`);
});
test('the server\'s fixed refusals are said in the interface language',()=>{
 for(const error of ['Mailbox not found','Sender account not found','You do not have permission to send from this mailbox','Sender address does not match the selected mailbox'])assert.equal(composeSendError({error},t,{status:403,rayId:'a5e2e7ef1e481496-FRA'}),de['compose.error.sendNotAllowed'],error);
 assert.equal(composeSendError({error:{fieldErrors:{to:['At least one recipient is required']}}},t,{status:400}),de['compose.error.noRecipient']);
 assert.equal(composeSendError({error:"Attachments exceed the administrator's 25 MB outgoing limit"},t,{status:400}),de['compose.error.sendTooLarge']);
});
test('a message that is too large and a lost sign-in are said in the interface language with what to do',()=>{
 assert.equal(composeSendError({error:'Request body is too large'},t,{status:413}),de['compose.error.sendTooLarge']);
 assert.equal(composeSendError(null,t,{status:413,rayId:'a5e2e7ef1e481496-FRA'}),de['compose.error.sendTooLarge'],'also when a proxy in front refused it');
 assert.equal(composeSendError({error:'Unauthorized'},t,{status:401}),de['compose.error.sendSignedOut']);
 assert.equal(composeSendError(null,t,{status:401}),de['compose.error.sendSignedOut'],'also when the answer was not JSON');
});
test('a connection that broke is named in the interface language, and never invites a blind second send',()=>{
 assert.equal(composeSendError(null,t,{network:true}),`${de['compose.error.sendFailed']} (${de['compose.error.sendNoConnection']}). ${de['compose.error.sendCheckFirst']}`);
 assert.equal(composeSendError(null,t,{network:true,detail:'Draft upload failed'}),`${de['compose.error.sendFailed']} (Draft upload failed). ${de['compose.error.sendCheckFirst']}`);
});
