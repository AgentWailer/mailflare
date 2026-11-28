import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-realtime-token-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));
writeFileSync(join(dir, 'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
await build({stdin: {contents: `
 export {getSessionTokenFromRequest} from './src/lib/realtime/utils';
 export {hasValidSessionMutationOrigin} from './src/lib/auth/origin';
`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', alias: {'next/headers': join(dir, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts'}, logLevel: 'silent'});
const {getSessionTokenFromRequest, hasValidSessionMutationOrigin} = await import(pathToFileURL(join(dir, 'app.mjs')).href);

const upgrade = (headers) => new Request('https://mailflare.test/api/realtime', {headers: {Upgrade: 'websocket', ...headers}});

test('an installed app opens the realtime connection with its bearer token', () => {
	const request = upgrade({Authorization: 'Bearer dev_token'});
	assert.equal(getSessionTokenFromRequest(request), 'dev_token');
	assert.equal(hasValidSessionMutationOrigin(request), true, 'a bearer request needs no browser origin');
});

test('a browser still opens it with its session cookie', () => {
	assert.equal(getSessionTokenFromRequest(upgrade({Cookie: 'theme=dark; ep_session=sess_abc%3D; other=1'})), 'sess_abc=');
	assert.equal(getSessionTokenFromRequest(upgrade({})), undefined);
	assert.equal(getSessionTokenFromRequest(upgrade({Authorization: 'Basic abc'})), undefined);
	assert.equal(getSessionTokenFromRequest(upgrade({Authorization: 'Bearer   '})), undefined);
});

test('an explicit bearer token wins over a cookie that happens to be present', () => {
	assert.equal(getSessionTokenFromRequest(upgrade({Authorization: 'Bearer dev_token', Cookie: 'ep_session=sess_other'})), 'dev_token');
});
