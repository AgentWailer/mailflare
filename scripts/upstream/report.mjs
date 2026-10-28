// Read-only upstream observation; never checks out, executes or merges upstream code.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const baseline=JSON.parse(readFileSync(new URL('./baseline.json',import.meta.url),'utf8'));
if(!/^[a-f0-9]{40}$/.test(baseline.reviewedCommit))throw Error('Invalid reviewed commit');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:8*1024*1024,timeout:90000});
const ref='refs/remotes/upstream-review/main';
git('-c','credential.helper=','-c','core.askPass=','fetch','--no-tags',baseline.repository,`+refs/heads/main:${ref}`);
const head=git('rev-parse',ref).trim();
git('merge-base','--is-ancestor',baseline.reviewedCommit,head); // Stop for review after upstream rewrites history.
const range=`${baseline.reviewedCommit}..${head}`;
const commits=git('log','--no-merges','--format=%H%x09%cI%x09%s',range).trim().split('\n').filter(Boolean).map(line=>{
 const [sha,date,...title]=line.split('\t');
 const files=git('diff-tree','--no-commit-id','--name-only','-r',sha).trim().split('\n').filter(Boolean);
 return {sha,date,title:title.join(' '),files,reviewPriority:/secur|auth|permission|sanitize|attachment|inbound|import|scheduled|jmap|backup|migrat|package-lock/i.test(title.join(' ')+' '+files.join(' '))?'Review first':'Normal review'};
});
const output=process.env.UPSTREAM_OUTPUT||'artifacts/upstream';mkdirSync(output,{recursive:true});
writeFileSync(join(output,'commits.json'),JSON.stringify({checkedAt:new Date().toISOString(),baseline,head,commits},null,2));
const escape=value=>value.replace(/[|<>`\r\n]/g,' ').replace(/\[/g,'(').replace(/\]/g,')');
const lines=['# Mailflare upstream review',`Checked: ${new Date().toISOString()}`,`Reviewed cursor: ${baseline.reviewedCommit}`,`Current upstream: ${head}`,`${commits.length} new non-merge commits. No automatic merge or deployment.`, '', '| Priority | Change | Commit |','|---|---|---|'];
for(const c of commits)lines.push(`| ${c.reviewPriority} | ${escape(c.title)} | [${c.sha.slice(0,7)}](https://github.com/hieunc229/mailflare/commit/${c.sha}) |`);
lines.push('', 'Priority is a filename/title heuristic, not a security verdict. Inspect the patches and test the fork. Advance the reviewed cursor only after recording adoption or deferral. Dependency audit is a separate artifact; warnings need runtime-specific assessment.');
writeFileSync(join(output,'report.md'),lines.join('\n')+'\n');
console.log(`Upstream review: ${commits.length} new commits; report in ${output}.`);
