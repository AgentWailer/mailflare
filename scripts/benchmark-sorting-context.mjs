import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
if (!process.argv.includes('--live')) throw Error('Pass --live to make paid Workers AI calls on synthetic messages.');
const cwd=process.cwd(),dir=mkdtempSync(cwd+'/node_modules/filter29-compare-');const {build}=await import(pathToFileURL(cwd+'/node_modules/esbuild/lib/main.js'));
try{
 for(const [name,path] of [['request','decision-request'],['learning','learning'],['routine','routine']])writeFileSync(dir+'/'+name+'.ts',execFileSync('git',['show','8c2f658:src/lib/mail-sorting/'+path+'.ts'],{cwd,encoding:'utf8'}).replaceAll('from "./','from "'+cwd+'/src/lib/mail-sorting/'));
 for(const version of ['before','after']){
 const prefix=version==='before'?dir:cwd+'/src/lib/mail-sorting';
 const contents=`export {buildSortingRequest} from '${prefix}/${version==='before'?'request':'decision-request'}.ts';export {getSortingExamples} from '${prefix}/learning.ts';export {resolveClefDecision} from '${cwd}/src/lib/mail-sorting/classifier.ts';export {analyzeAuthentication} from '${cwd}/src/lib/spam/analyzers/authentication.ts';export * from '${prefix}/routine.ts';`;
 await build({stdin:{contents,loader:'ts',resolveDir:cwd},outfile:dir+'/'+version+'.mjs',bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:cwd+'/tsconfig.json',alias:{'@':cwd+'/src','cloudflare:workers':cwd+'/server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
 }
 const apps={before:await import(pathToFileURL(dir+'/before.mjs')),after:await import(pathToFileURL(dir+'/after.mjs'))};
 const feedback=[
 {from_addr:'security@example.test',subject:'Security update',category:'primary',excerpt:'Your password was changed. If this was not you, contact support.',source:'user'},
 {from_addr:'legal@example.test',subject:'Ihre Email zum Widerspruch',category:'primary',excerpt:'Aktenzeichen TEST-123. Wir prüfen Ihren Widerspruch.',source:'user'},
 {from_addr:'billing@example.test',subject:'Ihre Rechnung',category:'invoices',excerpt:'Invoice INV-123, amount due 49 EUR.',source:'user'},
 {from_addr:'shop@example.test',subject:'Order shipped',category:'orders',excerpt:'Your order 456 is on its way.',source:'user'},
 {from_addr:'newsletter@example.test',subject:'Weekly offers',category:'promotions',excerpt:'Browse our new products. Unsubscribe.',source:'user'},
 {from_addr:'community@example.test',subject:'Network digest',category:'social',excerpt:'New posts from your community.',source:'user'}
 ];
 const cases=[];
 const synthetic=JSON.parse(readFileSync(cwd+'/tests/fixtures/sorting-decisions.json')).map(r=>({id:r.id,index:r.id,expected:r.expected,kind:'synthetic',headers:r.listMail?{'List-Unsubscribe':'<https://example.test/unsub>'}:{},state:{sender:'sender@example.test',recipient:'owner@example.test',subject:r.subject,visibleText:r.text,spamScore:r.spamScore??0,authentication:r.authentication??[],relationship:'unknown',listMail:r.listMail??false,userCorrections:[]}}));
 const rows=[];
 for(let run=0;run<2;run++)for(const row of [...cases,...synthetic])for(const version of run%2?['after','before']:['before','after']){
  const app=apps[version];const env={DB:{prepare:()=>({bind:(_box,sender)=>({all:async()=>({results:sender?feedback.filter(r=>r.from_addr===sender):feedback})})})}};
  const state={...row.state,listMail:Object.keys(row.headers).some(k=>k.toLowerCase()==='list-unsubscribe'),authentication:row.kind==='real'?app.analyzeAuthentication(row.headers).map(x=>x.id):row.state.authentication,userCorrections:await app.getSortingExamples(env,'box',{sender:row.state.sender,subject:row.state.subject})};
  const input={sender:state.sender,subject:state.subject,text:state.visibleText,headers:row.headers};
  // Mirrors the unchanged deterministic guards before AI; sender overrides are outside this comparison.
  let rule=null;
  if(state.spamScore<40&&!state.authentication.some(id=>id.endsWith('_failed'))){
   if(app.isConsequentialNotice(input)||app.isProtectedRoutineMail(input))rule={category:'primary'};
   const transaction=app.resolveTransactionMail(input);if(transaction&&!app.isAccountSecurityNotice(input)&&!app.isConsequentialNotice(input))rule=transaction;
  }
  rule??=app.resolveRoutineMail(input);
  const start=performance.now();const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-omni`,{method:'POST',headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(app.buildSortingRequest(state)),signal:AbortSignal.timeout(20000)});
  const data=await r.json();if(!r.ok||!data.success)throw Error('AI HTTP '+r.status);
  const d=app.resolveClefDecision(data.result.answers,.8,state.spamScore);
  rows.push({index:row.index,kind:row.kind,run,version,expected:row.expected,category:rule?.category??(d.spam?'spam':d.category),modelCategory:d.spam?'spam':d.category,decision:d,examples:state.userCorrections.length,answers:data.result.answers,ms:Math.round(performance.now()-start),tokens:data.result.usage?.input_tokens??0});
  writeFileSync(process.env.SORTING_OUTPUT || '/tmp/mailflare-context-comparison.json',JSON.stringify(rows));
  if(process.env.SORTING_VERBOSE)console.log(JSON.stringify({index:row.index,run,version,expected:row.expected,category:rows.at(-1).category,examples:state.userCorrections.length}));
 }
 for(const kind of ['synthetic'])for(const version of ['before','after']){const r=rows.filter(x=>x.kind===kind&&x.version===version);console.log(JSON.stringify({kind,version,runs:r.length,matches:r.filter(x=>x.category===x.expected).length,important:r.filter(x=>x.expected==='primary').length,hiddenImportant:r.filter(x=>x.expected==='primary'&&['promotions','spam','social'].includes(x.category)).length,tokens:r.reduce((a,x)=>a+x.tokens,0)}));}
}finally{rmSync(dir,{recursive:true,force:true});}
