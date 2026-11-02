import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export const browserSmokeSuites = [
  'visual-polish',
  'attachment-preview',
  'compose-window',
  'label-actions',
  'message-star-feedback',
  'draft-recovery',
  'queue-health-card',
  'login-entry',
  'cookie-session',
].map(name => ({ name, args: [`tests/browser/${name}.mjs`] }));

function failureExcerpt(tail) {
  // Keep the assertion/message instead of only the final Node.js stack frame.
  const lines = tail.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim().split(/\r?\n/);
  const error = lines.findIndex(line => /(?:\b\w*Error\b|ERR_|\bnot ok\b)/.test(line));
  return lines.slice(error >= 0 ? error : -3, error >= 0 ? error + 3 : undefined).join('\n').slice(0, 350);
}

export async function runBrowserSmoke({
  suites = browserSmokeSuites,
  outputDirectory = resolve('artifacts/quality'),
  write = chunk => process.stdout.write(chunk),
} = {}) {
  mkdirSync(outputDirectory, { recursive: true });
  const results = [];
  // Each suite may start workerd's inspector. Await process close before starting
  // the next one, including after an assertion failure or a launch error.
  for (const suite of suites) {
    const logPath = join(outputDirectory, `browser-${suite.name}.log`);
    const log = openSync(logPath, 'w');
    const started = performance.now();
    let tail = '';
    const capture = text => {
      tail = (tail + text).slice(-16_000);
      write(text);
    };
    write(`\nRunning browser smoke: ${suite.name}\n`);
    let outcome;
    try {
      outcome = await new Promise(resolveResult => {
        const child = spawn(process.execPath, suite.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) {
          const decoder = new StringDecoder('utf8');
          stream.on('data', chunk => {
            writeSync(log, chunk);
            capture(decoder.write(chunk));
          });
          stream.on('end', () => capture(decoder.end()));
        }
        child.on('error', error => {
          const message = `Error: ${error.message}\n`;
          writeSync(log, message);
          capture(message);
        });
        child.on('close', (code, signal) => resolveResult({ code, signal }));
      });
    } finally {
      closeSync(log);
    }
    results.push({
      name: suite.name,
      ...outcome,
      passed: outcome.code === 0,
      durationMs: Math.round(performance.now() - started),
      logPath: relative(process.cwd(), logPath),
      ...(outcome.code !== 0 ? { excerpt: failureExcerpt(tail) } : {}),
    });
  }
  const failures = results.filter(result => !result.passed);
  writeFileSync(join(outputDirectory, 'browser-smoke-summary.json'), JSON.stringify(results, null, 2) + '\n');
  // Nine failures still fit within the workflow's final 45-line/5,000-character
  // public annotation. Complete, untruncated output stays in the suite log files.
  write(`\nBrowser smoke: ${results.length - failures.length}/${results.length} suites passed.\n`);
  for (const failure of failures) {
    write(`FAIL ${failure.name} (${failure.signal || `exit ${failure.code}`}): ${failure.logPath}\n${failure.excerpt}\n`);
  }
  write(`Complete suite logs and summary: ${relative(process.cwd(), outputDirectory)}\n`);
  return { results, failed: failures.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { failed } = await runBrowserSmoke();
  process.exitCode = failed ? 1 : 0;
}
