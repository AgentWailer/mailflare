import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBrowserSmoke } from '../scripts/run-browser-smoke.mjs';

test('browser smoke continues sequentially after failure and preserves each complete log', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mailflare-smoke-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'active');
  let output = '';
  const { results, failed } = await runBrowserSmoke({
    outputDirectory: directory,
    write: chunk => { output += chunk; },
    suites: [
      { name: 'fails', args: ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'active');console.log('full log '.repeat(3000));console.error('AssertionError: expected layout');setTimeout(()=>{fs.unlinkSync(${JSON.stringify(marker)});process.exitCode=7;},20);`] },
      { name: 'passes', args: ['-e', `require('node:assert/strict').equal(require('node:fs').existsSync(${JSON.stringify(marker)}),false);console.log('next suite completed');`] },
    ],
  });
  assert.equal(failed, 1);
  assert.deepEqual(results.map(result => [result.name, result.code]), [['fails', 7], ['passes', 0]]);
  assert(readFileSync(join(directory, 'browser-fails.log'), 'utf8').length > 16_000);
  assert.match(readFileSync(join(directory, 'browser-fails.log'), 'utf8'), /AssertionError: expected layout/);
  assert.match(readFileSync(join(directory, 'browser-passes.log'), 'utf8'), /next suite completed/);
  assert.match(output.split('Browser smoke:').at(-1), /1\/2 suites passed[\s\S]*FAIL fails[\s\S]*AssertionError: expected layout/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'browser-smoke-summary.json'), 'utf8')).length, 2);
});

test('browser smoke reports success when every suite succeeds', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mailflare-smoke-success-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let output = '';
  const { failed } = await runBrowserSmoke({
    suites: [{ name: 'first', args: ['-e', 'console.log("first complete")'] }, { name: 'second', args: ['-e', 'console.log("second complete")'] }],
    outputDirectory: directory,
    write: chunk => { output += chunk; },
  });
  assert.equal(failed, 0);
  assert.match(output, /2\/2 suites passed/);
  assert.doesNotMatch(output, /FAIL /);
});
