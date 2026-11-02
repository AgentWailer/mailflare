// Real production Vinext + local D1 + browser cookie round trip. No API mocks,
// registration, mail records, queue jobs, Cloudflare API calls or production data.
// Run after a build: node tests/browser/cookie-session.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import bcrypt from 'bcryptjs';

const { chromium } = await import(process.env.MAILFLARE_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), builtConfig = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
const binding = builtConfig.d1_databases.find(item => item.binding === 'DB');
assert(binding, 'Built Worker must expose the existing DB binding');
for (const file of ['.dev.vars', 'dist/server/.dev.vars']) {
 assert(!existsSync(file), `Run this isolated check from a build without ${file}; local secrets must not enter the fixture`);
}
const temporary = mkdtempSync(join(tmpdir(), 'mailflare-cookie-browser-'));
const state = join(temporary, 'state'), configPath = join(temporary, 'wrangler.json');
writeFileSync(configPath, JSON.stringify({ name: 'mailflare-cookie-fixture', compatibility_date: builtConfig.compatibility_date, d1_databases: [{ binding: 'DB', database_name: 'cookie-fixture', database_id: binding.database_id, migrations_dir: resolve('drizzle/migrations') }] }));
const childEnv = { ...process.env, XDG_CONFIG_HOME: temporary, CLOUDFLARE_REMOTE_BINDINGS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false', MAILFLARE_LOCAL_STATE_PATH: state };
for (const key of Object.keys(childEnv)) if (/^(CF_|CLOUDFLARE_API_|TURNSTILE_|NEXT_PUBLIC_TURNSTILE_|AWS_|R2_)/.test(key)) delete childEnv[key];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wrangler(args) {
 const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', configPath, '--persist-to', state], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
 let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output += chunk);
 const [code] = await once(child, 'exit');
 assert.equal(code, 0, `Local fixture command failed: ${output.slice(-4000)}`);
}
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`, email = 'cookie-fixture@example.test', password = 'Local cookie fixture password!';
let preview, browser, serverLog = '';
try {
 await wrangler(['d1', 'migrations', 'apply', 'DB', '--local']);
 const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
 const now = Math.floor(Date.now() / 1000), hash = bcrypt.hashSync(password, 12);
 const sql = `INSERT INTO users (id,email,password_hash,name,role,is_primary_admin,created_at) VALUES ('cookie-user',${quote(email)},${quote(hash)},'Cookie Fixture','admin',1,${now});
INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('cookie-domain','cookie-user','example.test','synthetic-local-zone','active',${now});
INSERT INTO mailboxes (id,user_id,domain_id,local_part,display_name,created_at) VALUES ('cookie-box','cookie-user','cookie-domain','cookie-fixture','Cookie Fixture',${now});`;
 const sqlPath = join(temporary, 'fixture.sql'); writeFileSync(sqlPath, sql);
 await wrangler(['d1', 'execute', 'DB', '--local', '--file', sqlPath]);
 preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
 for (const stream of [preview.stdout, preview.stderr]) stream.on('data', chunk => serverLog += chunk);
 let ready = false;
 for (let attempt = 0; attempt < 120; attempt++) {
  try { const response = await fetch(origin + '/api/auth/me', { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.status === 401) { ready = true; break; } } catch {}
  if (preview.exitCode !== null) throw new Error('Preview exited before readiness');
  await pause(250);
 }
 assert(ready, 'Preview should serve an unauthenticated real API response');
 browser = await chromium.launch({ headless: true, executablePath: process.env.MAILFLARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
 const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 850 } });
 const page = await context.newPage(), errors = [], apiAuthorization = [], external = [];
 page.on('pageerror', error => errors.push(error.message));
 page.on('request', request => { const url = new URL(request.url()); if (url.origin !== origin && ['https:', 'http:'].includes(url.protocol)) external.push(url.origin); if (url.pathname.startsWith('/api/') && request.headers().authorization) apiAuthorization.push(url.pathname); });
 await page.goto(origin + '/login');
 await page.getByLabel('Email', { exact: true }).fill(email);
 await page.getByLabel('Password', { exact: true }).fill(password);
 const loginPending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
 await page.getByRole('button', { name: 'Sign in', exact: true }).click();
 const login = await loginPending; assert.equal(login.status(), 200);
 const cookies = await context.cookies(), session = cookies.find(cookie => cookie.name === 'ep_session'), accounts = cookies.find(cookie => cookie.name === 'ep_accounts');
 assert(session && accounts, 'Both Set-Cookie headers survive the production adapter');
 assert(session.httpOnly && accounts.httpOnly, 'Browser scripts cannot read either session cookie');
 assert(session.secure && accounts.secure, 'Production sets Secure even on trusted localhost');
 assert(session.sameSite === 'Lax' && accounts.sameSite === 'Lax');
 assert((await login.json()).token === session.value, 'Native login JSON remains compatible with cookie session');
 await page.waitForURL(origin + '/inbox');
 await page.waitForFunction(() => !!localStorage.getItem('mailflare-session-scope'));
 assert(await page.evaluate(() => !document.cookie.includes('ep_session') && !document.cookie.includes('ep_accounts')));
 assert(await page.evaluate(secret => !Object.values(localStorage).some(value => value.includes(secret)) && localStorage.getItem('mailflare-session-token') === null, session.value), 'The server credential is never persisted in JavaScript storage');
 const validated = await page.evaluate(async () => { const response = await fetch('/api/auth/me'); const data = await response.json(); return { status: response.status, id: data.user?.id }; });
 assert.deepEqual(validated, { status: 200, id: 'cookie-user' });
 // Simulate a returning browser with a valid HttpOnly cookie and cleared local storage.
 await page.evaluate(() => localStorage.clear());
 await page.reload();
 await page.waitForFunction(() => localStorage.getItem('mailflare-session-scope')?.startsWith('scope:'));
 assert.equal(new URL(page.url()).pathname, '/inbox');
 const restored = await page.evaluate(async () => (await fetch('/api/auth/me')).status); assert.equal(restored, 200);
 await page.getByRole('button', { name: 'Open account menu', exact: true }).click();
 const logoutPending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
 await page.getByRole('button', { name: 'Sign out', exact: true }).click();
 assert.equal((await logoutPending).status(), 200);
 await page.waitForURL(origin + '/login');
 assert(!(await context.cookies()).some(cookie => cookie.name === 'ep_session' || cookie.name === 'ep_accounts'), 'Confirmed logout expires both cookies');
 assert.equal(await page.evaluate(() => localStorage.getItem('mailflare-session-scope')), null);
 assert.equal(await page.evaluate(async () => (await fetch('/api/auth/me')).status), 401);
 assert.deepEqual(apiAuthorization, [], 'The actual application never sends a Bearer token');
 assert.deepEqual(external, [], 'This fixture makes no external browser requests');
 assert.deepEqual(errors, []);
 console.log('Real Vinext cookie session passed: login, two Secure/HttpOnly cookies, cookie-only API, cleared-storage reload, UI logout and revoked-session 401; isolated local D1 only.');
} catch (error) {
 // Runtime diagnostics exclude session cookie/token values; never print response bodies.
 console.error(serverLog.replace(/sess_[A-Za-z0-9_-]+/g, '[session redacted]').slice(-4000));
 throw error;
} finally {
 await browser?.close();
 if (preview && preview.exitCode === null) { preview.kill('SIGTERM'); await once(preview, 'exit'); }
 rmSync(temporary, { recursive: true, force: true });
}
