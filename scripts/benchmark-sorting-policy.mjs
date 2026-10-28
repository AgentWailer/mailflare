import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
// Opt-in native Workers AI comparison on synthetic fixtures only; never reads a mailbox.
if (!process.argv.includes('--live')) throw Error('Pass --live to run paid inference on synthetic fixtures.');
if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) throw Error('Configured Cloudflare credentials required.');
// Frozen policy 7 resolver; git history must contain this commit.
const cwd=process.cwd();const {build}=await import(pathToFileURL(join(cwd,'node_modules/esbuild/lib/main.js')));
const dir=mkdtempSync(join(cwd,'node_modules/sorting-compare-'));
try{
 const original=execFileSync('git',['show','12dcb24:src/lib/mail-sorting/classifier.ts'],{encoding:'utf8'}).replaceAll('from "./','from "'+cwd+'/src/lib/mail-sorting/');
 await build({stdin:{contents:original,loader:"ts",resolveDir:cwd},outfile:join(dir,'old.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',alias:{'cloudflare:workers':cwd+'/server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
 await build({stdin:{contents:"export {buildSortingRequest} from './src/lib/mail-sorting/decision-request';export {resolveClefDecision} from './src/lib/mail-sorting/classifier';export {prepareSpamContent} from './src/lib/spam/tokenizer';",resolveDir:cwd},outfile:join(dir,'new.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',alias:{'cloudflare:workers':cwd+'/server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
 const previous=await import(pathToFileURL(join(dir,'old.mjs')));const app=await import(pathToFileURL(join(dir,'new.mjs')));
 const fixtures=JSON.parse(readFileSync('tests/fixtures/sorting-decisions.json','utf8'));
 const rows=[];
 for(let run=0;run<2;run++)for(const fixture of fixtures){
  const state={sender:'sender@example.test',recipient:'owner@example.test',subject:fixture.subject,visibleText:fixture.text,spamScore:fixture.spamScore??0,authentication:fixture.authentication??['dmarc_passed','dkim_passed'],relationship:'unknown',listMail:fixture.listMail??false,userCorrections:[]};
  for(const version of (run%2?['after','before']:['before','after'])){
   const request=app.buildSortingRequest(state);if(version==='before'){delete request.questions.marketing;request.state=state;}
   const start=performance.now();const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-omni`,{method:'POST',headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(20000)});
   const data=await r.json();if(!r.ok||!data.success)throw Error('AI HTTP '+r.status);
   const d=(version==='before'?previous:app).resolveClefDecision(data.result.answers,.8,state.spamScore);
   const row={id:fixture.id,run,version,expected:fixture.expected,category:d.spam?'spam':d.category,reason:d.reason,marketing:d.marketingProbability,ms:Math.round(performance.now()-start),tokens:data.result.usage.input_tokens,answers:data.result.answers};rows.push(row);
  }
 }
 writeFileSync(process.env.SORTING_OUTPUT || '/tmp/mailflare-marketing-comparison.json',JSON.stringify(rows,null,2));
 for(const version of ['before','after']){const r=rows.filter(x=>x.version===version);const ms=r.map(x=>x.ms).sort((a,b)=>a-b);console.log(JSON.stringify({version,total:r.length,correct:r.filter(x=>x.expected===x.category).length,ads:r.filter(x=>x.expected==='promotions').length,adsCorrect:r.filter(x=>x.expected==='promotions'&&x.category==='promotions').length,important:r.filter(x=>x.expected==='primary').length,hiddenImportant:r.filter(x=>x.expected==='primary'&&['promotions','spam'].includes(x.category)).length,p50:ms[Math.ceil(ms.length*.5)-1],p95:ms[Math.ceil(ms.length*.95)-1],tokens:r.reduce((s,x)=>s+x.tokens,0)}));}
 console.log(JSON.stringify(rows.filter(x=>x.version==='after'&&x.expected!==x.category).map(row=>({id:row.id,run:row.run,expected:row.expected,category:row.category,reason:row.reason}))));
}finally{rmSync(dir,{recursive:true,force:true});}
