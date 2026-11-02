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
