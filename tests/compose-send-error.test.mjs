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
test('a failure the server words itself keeps its status and Ray ID',()=>{
 assert.equal(composeSendError({error:'Upstream provider unavailable.'},t,{status:502,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendFailed']}: Upstream provider unavailable (HTTP 502, Ray a5e2e7ef1e481496). ${de['compose.error.sendCheckFirst']}`);
 assert.equal(composeSendError({error:'Quota reached'},t,{status:429,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendFailed']}: Quota reached. ${de['compose.error.sendRetry']}`,'a refusal is explained by its own words');
});
test('a failure said after the window was closed points to Drafts, never to a window that is gone',()=>{
 const closed=[composeSendError({error:'Queue write failed.'},t,{status:500,closed:true}),composeSendError(null,t,{status:403,closed:true}),composeSendError(null,t,{network:true,closed:true}),composeSendError(null,t,{status:401,closed:true})];
 for(const text of closed){assert.match(text,/Entwürfe/);assert.doesNotMatch(text,/hier noch geöffnet|dieses Fenster/);}
 assert.match(closed[0],/HTTP 500/);
 // A refusal that names a field of the window says where the message is, once that window is gone.
 for(const [data,status] of [[{error:'Mailbox not found'},403],[{error:'Request body is too large'},413],[{error:'Too many recipients'},400],[{code:'attachment_unavailable',filename:'a.pdf'},409]]){const text=composeSendError(data,t,{status,closed:true});assert.match(text,/Entwürfe/,text);assert.equal((text.match(/Entwürfe/g)??[]).length,1,text);}
 assert.doesNotMatch(composeSendError({error:'Mailbox not found'},t,{status:403}),/Entwürfe/,'with the window open the advice is about the window');
 assert.equal(composeSendError({code:'delivery_status_pending',error:'x'},t,{status:500,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.deliveryStatusPending']} (HTTP 500, Ray a5e2e7ef1e481496)`);
 assert.equal(composeSendError({code:'delivery_unknown',error:'x'},t,{status:502}),`${de['compose.error.deliveryUnknown']} (HTTP 502)`);
});
test('structured validation payloads and absent bodies never become React children',()=>{
 for(const value of [{error:{fieldErrors:{body:['Invalid']}}},{error:{formErrors:['Invalid']}},null,{},'proxy error'])assert.equal(composeSendError(value,t),de['compose.error.sendFailed']);
});
test('HTTP status and Cloudflare Ray ID are kept, and each failure says what to do next',()=>{
 // A refusal changed nothing: trying again is safe.
 assert.equal(composeSendError(null,t,{status:403,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendFailed']} (HTTP 403, Ray a5e2e7ef1e481496). ${de['compose.error.sendRetry']}`);
 // A gateway that gave up may have done so after the message was accepted: look before sending twice.
 for(const status of [500,502,504,524])assert.equal(composeSendError(null,t,{status,rayId:'invalid ray!'}),`${de['compose.error.sendFailed']} (HTTP ${status}). ${de['compose.error.sendCheckFirst']}`);
 assert.equal(composeSendError({error:'Queue write failed.'},t,{status:500}),`${de['compose.error.sendFailed']}: Queue write failed (HTTP 500). ${de['compose.error.sendCheckFirst']}`);
 assert.equal(composeSendError({error:{fieldErrors:{threadId:['Thread id is too long']}}},t,{status:400}),`${de['compose.error.sendFailed']}: Thread id is too long. ${de['compose.error.sendRetry']}`);
 // A success that names no message leaves the outcome open: it must not invite a second send.
 assert.equal(composeSendError(null,t,{status:200,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendFailed']}. ${de['compose.error.sendCheckFirst']}`);
});
test('the server\'s fixed refusals are said in the interface language',()=>{
 for(const error of ['Mailbox not found','Sender account not found','You do not have permission to send from this mailbox','Sender address does not match the selected mailbox'])assert.equal(composeSendError({error},t,{status:403,rayId:'a5e2e7ef1e481496-FRA'}),de['compose.error.sendNotAllowed'],error);
 assert.equal(composeSendError({error:{fieldErrors:{to:['At least one recipient is required']}}},t,{status:400}),de['compose.error.noRecipient']);
 assert.equal(composeSendError({error:"Attachments exceed the administrator's 25 MB outgoing limit"},t,{status:400}),de['compose.error.sendTooLarge']);
 // The validator words its refusals in English; the field it names says which translated sentence fits.
 assert.equal(composeSendError({error:{fieldErrors:{subject:['Too big: expected string to have <=500 characters']}}},t,{status:400}),de['compose.error.sendSubjectTooLong']);
 // An empty subject is not a long one.
 for(const said of ['Too small: expected string to have >=1 characters','String must contain at least 1 character(s)','Required'])assert.equal(composeSendError({error:{fieldErrors:{subject:[said]}}},t,{status:400}),de['compose.error.sendSubjectMissing'],said);
 assert.equal(composeSendError({error:{fieldErrors:{html:['Too big: expected string to have <=2097152 characters']}}},t,{status:400}),de['compose.error.sendBodyTooLong'],'a long text is not an attachment problem');
 assert.equal(composeSendError({error:{fieldErrors:{from:['Too small: expected string to have >=3 characters']}}},t,{status:400}),de['compose.error.sendNotAllowed']);
 assert.equal(composeSendError({error:{fieldErrors:{bcc:['Too big: expected array to have <=50 items']}}},t,{status:400}),de['compose.error.sendRecipientsRefused']);
 assert.equal(composeSendError({error:'A message can have at most 50 recipients'},t,{status:400}),de['compose.error.sendTooManyRecipients']);
 assert.equal(composeSendError({error:"Subject exceeds Cloudflare's 998-character limit"},t,{status:400}),de['compose.error.sendSubjectTooLong']);
 assert.equal(composeSendError({error:'Draft not found'},t,{status:404}),de['compose.error.sendDraftGone']);
 assert.match(de['compose.error.sendDraftGone'],/Gesendet/,'a draft that is gone was most likely sent: the advice is to look, not to send again');
 assert.equal(composeSendError({error:'Invalid send request'},t,{status:400}),`${de['compose.error.sendFailed']}: Invalid send request. ${de['compose.error.sendRetry']}`);
});
test('a message that is too large and a lost sign-in are said in the interface language with what to do',()=>{
 assert.equal(composeSendError({error:'Request body is too large'},t,{status:413}),de['compose.error.sendTooLarge']);
 assert.equal(composeSendError(null,t,{status:413,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendTooLarge']} (HTTP 413, Ray a5e2e7ef1e481496)`,'a proxy in front refused it: its status and Ray ID stay for support');
 assert.equal(composeSendError('<html>too large</html>',t,{status:413}),`${de['compose.error.sendTooLarge']} (HTTP 413)`);
 assert.equal(composeSendError({error:'Request body is too large'},t,{status:413,rayId:'a5e2e7ef1e481496-FRA'}),`${de['compose.error.sendTooLarge']} (HTTP 413, Ray a5e2e7ef1e481496)`,'also when the answer is ours but came through the proxy');
 assert.equal(composeSendError({error:'Unauthorized'},t,{status:401}),de['compose.error.sendSignedOut']);
 assert.equal(composeSendError(null,t,{status:401}),de['compose.error.sendSignedOut'],'also when the answer was not JSON');
});
test('a connection that broke is named in the interface language, and never invites a blind second send',()=>{
 assert.equal(composeSendError(null,t,{network:true}),`${de['compose.error.sendFailed']} (${de['compose.error.sendNoConnection']}). ${de['compose.error.sendCheckFirst']}`);
 assert.equal(composeSendError(null,t,{network:true,detail:'Draft upload failed'}),`${de['compose.error.sendFailed']} (Draft upload failed). ${de['compose.error.sendCheckFirst']}`);
});
