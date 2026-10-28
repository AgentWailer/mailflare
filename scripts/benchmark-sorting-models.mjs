// Opt-in, bounded live comparison: synthetic mail only; never reads or sorts a mailbox.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
if (!process.argv.includes('--live')) throw Error('Use --live to run paid Cloudflare inference on synthetic fixtures.');
const models=(process.env.SORTING_MODELS||'clef-flash,clef,clef-omni').split(',');
if(models.some(m=>!['clef-flash','clef','clef-omni'].includes(m)))throw Error('Unsupported benchmark model');
const runs=Number(process.env.SORTING_RUNS||1);if(!Number.isInteger(runs)||runs<1||runs>3)throw Error('Runs must be 1–3');
if(!process.env.CLOUDFLARE_API_TOKEN||!process.env.CLOUDFLARE_ACCOUNT_ID)throw Error('Cloudflare account and token environment variables required');
const fixtures=JSON.parse(readFileSync('tests/fixtures/sorting-decisions.json','utf8'));
const dir=mkdtempSync(join(process.cwd(),'node_modules','sorting-bench-'));
try {
 await build({stdin:{contents:"export {buildSortingRequest} from './src/lib/mail-sorting/decision-request'; export {resolveClefDecision} from './src/lib/mail-sorting/classifier';",resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',alias:{'cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
 const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
 const results=[];
 for(let run=0;run<runs;run++)for(const fixture of fixtures)for(const model of [...models.slice(run%models.length),...models.slice(0,run%models.length)]) {
  const state={sender:'sender@example.test',recipient:'owner@example.test',subject:fixture.subject,visibleText:fixture.text,spamScore:fixture.spamScore??0,authentication:fixture.authentication??['dmarc_passed','dkim_passed'],relationship:'unknown',listMail:fixture.listMail??false,userCorrections:[]};
  const started=performance.now();let row={id:fixture.id,model,run,expected:fixture.expected};
  try {
   const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(app.buildSortingRequest(state,model)),signal:AbortSignal.timeout(20000)});
   const data=await r.json();if(!r.ok||!data.success)throw Error('Inference HTTP '+r.status+' '+JSON.stringify(data.errors));
   const result=data.result,decision=app.resolveClefDecision(result.answers??{},.8,state.spamScore),category=decision.spam?'spam':decision.category;
   row={...row,elapsedMs:Math.round(performance.now()-started),actualModel:result.model,choice:result.answers?.category?.choice,category,reason:decision.reason,correct:category===fixture.expected,hiddenImportant:fixture.expected==='primary'&&['promotions','spam'].includes(category),usage:result.usage,answers:result.answers};
  }catch(error){row={...row,elapsedMs:Math.round(performance.now()-started),error:error instanceof Error?error.message:'Inference failed'};}
  results.push(row);console.log(JSON.stringify({id:row.id,model,run,ms:row.elapsedMs,category:row.category,reason:row.reason,error:row.error}));
 }
 const percentile=(a,p)=>[...a].sort((a,b)=>a-b)[Math.max(0,Math.ceil(a.length*p)-1)]??null;
 const summary=models.map(model=>{const rows=results.filter(r=>r.model===model),ok=rows.filter(r=>!r.error);return {model,total:rows.length,success:ok.length,correct:ok.filter(r=>r.correct).length,hiddenImportant:ok.filter(r=>r.hiddenImportant).length,p50:percentile(ok.map(r=>r.elapsedMs),.5),p95:percentile(ok.map(r=>r.elapsedMs),.95),inputTokens:ok.reduce((sum,r)=>sum+(r.usage?.input_tokens??0),0)};});
 const report={date:new Date().toISOString(),method:'Sequential REST from workspace; synthetic DE mail; model plus policy, before deterministic shortcuts; not native binding latency or field accuracy',results,summary};
 writeFileSync(process.env.SORTING_OUTPUT||'/tmp/mailflare-sorting-model-benchmark.json',JSON.stringify(report,null,2));console.log(JSON.stringify({summary}));
} finally {rmSync(dir,{recursive:true,force:true});}
