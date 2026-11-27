// Readers of outside input fed with seeded random and deliberately broken data. Each run is
// reproducible: a failure names the round, and the seed below never changes between runs.
// What is checked is behaviour: nothing crashes, nothing hangs, and what was put in comes out.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd(), dir = mkdtempSync(join(root, 'node_modules', 'parser-fuzz-'));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	stdin: { contents: `
		export {SqliteDatabase} from './server/runtime/sqlite-database';
		export {applyMigrations} from './server/runtime/migrate';
		export {buildFtsMatch,parseSearchQuery,setSearchIncludeSpam} from './src/lib/search/query-utils';
		export {formatEmailAddress,getEmailAddressList,joinEmailAddressList,parseEmailAddressParts,splitEmailAddressList} from './src/lib/email/address';
		export {parseRawMime,buildSnippet} from './src/lib/email/parse';
		export {filterToSql} from './src/lib/jmap/email-query';
		export {JmapError} from './src/lib/jmap/errors';
		export {parseRecipientEntries,isValidRecipient} from './src/components/compose/recipient-utils';
		export {skeleton,withinOneEdit,registrableDomain} from './src/lib/email/confusables';
	`, resolveDir: root },
	outfile: join(dir, 'entry.mjs'), bundle: true, format: 'esm', platform: 'node', packages: 'external',
	alias: { 'cloudflare:workers': './server/runtime/cloudflare-workers.ts', 'next/headers': 'next/headers.js', 'next/server': 'next/server.js' },
	tsconfig: join(root, 'tsconfig.json'), logLevel: 'silent',
});
const app = await import(pathToFileURL(join(dir, 'entry.mjs')).href);

/** Small deterministic generator (mulberry32). */
function generator(seed) {
	let state = seed >>> 0;
	const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
	const int = limit => Math.floor(next() * limit);
	const pick = list => list[int(list.length)];
	return { next, int, pick, text: (alphabet, max) => Array.from({ length: int(max + 1) }, () => pick(alphabet)).join('') };
}
// Characters that have broken parsers before: quoting, grammar marks, separators, controls, other scripts, emoji, lone surrogates.
const NASTY = ['"', "'", '\\', '<', '>', ',', ';', ':', '@', '.', '-', '*', '(', ')', '^', '+', '{', '}', '[', ']', '%', '_', '|', '&', '~', '/', '=', '?', '!', '#',
	' ', '\t', '\n', '\r', '\0', '​', '‮', '﻿', 'a', 'B', 'z', '0', '9', 'ä', 'ß', 'đ', 'к', '日', '🎉', '\ud83d', '\udc00', 'AND', 'OR', 'NOT', 'NEAR'];

test('no search text a person can type breaks the full-text query', async t => {
	const DB = new app.SqliteDatabase(':memory:');
	t.after(() => DB.db.close());
	await app.applyMigrations(DB, join(root, 'drizzle/migrations'));
	DB.db.exec(`INSERT INTO users(id,email,password_hash,name,created_at) VALUES('u','u@example.test','x','U',1);
	INSERT INTO domains(id,user_id,hostname,zone_id,created_at) VALUES('d','u','example.test','z',1);
	INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('box','u','d','u',1);
	INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,created_at) VALUES
	('m1','u','box','inbound','Maya Chen <maya@acme.test>','u@example.test','Invoice 2026 "final"','Please pay the invoice (NOT later) AND confirm.','received',1),
	('m2','u','box','inbound','sam@harbor.test','u@example.test','Größe: C++ & *stars*','Übergröße naïve 日本語 text','received',2);`);
	const search = DB.db.prepare('SELECT id FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ORDER BY id');
	const run = raw => { const match = app.buildFtsMatch(app.parseSearchQuery(raw)); return match === null ? null : search.all(match).map(row => row.id); };

	// The index answers at all, so a silent "matches nothing" below would be noticed.
	assert.deepEqual(run('invoice'), ['m1']);
	assert.deepEqual(run('inv'), ['m1'], 'prefix');
	assert.deepEqual(run('from:maya subject:invoice'), ['m1']);
	assert.deepEqual(run('"pay the invoice" -harbor'), ['m1']);
	assert.deepEqual(run('größe'), ['m2']);
	assert.equal(run(''), null);

	const random = generator(20261126);
	const operators = ['from:', 'to:', 'subject:', 'title:', 'has:', 'is:', 'in:', 'after:', 'before:', 'newer:', 'older:', ':unread', ':read', '-', '"', 'from:"', 'subject:"a b', 'in:anywhere', 'after:2026-13-45', 'before:0000-00-00', 'has:attachment', 'is:starred'];
	for (let round = 0; round < 4000; round++) {
		const raw = Array.from({ length: random.int(7) }, () => random.int(3) === 0 ? random.pick(operators) + random.text(NASTY, 4) : random.text(NASTY, 8)).join(random.pick(['', ' ', '  ']));
		let result;
		try { result = run(raw); } catch (error) { assert.fail(`round ${round}, query ${JSON.stringify(raw)}: ${error.message}`); }
		assert(result === null || Array.isArray(result));
		// Opting spam in and out again must leave a query that still parses.
		try { app.parseSearchQuery(app.setSearchIncludeSpam(app.setSearchIncludeSpam(raw, true), false)); } catch (error) { assert.fail(`round ${round}, spam toggle on ${JSON.stringify(raw)}: ${error.message}`); }
	}
});

test('address lists: formatted recipients come back unchanged, and garbage never throws or loses the address', () => {
	const random = generator(42);
	const nameAlphabet = ['"', '\\', ',', ';', '<', '>', '(', ')', ':', '@', '.', "'", ' ', 'a', 'Z', 'é', 'ö', '日', '🎉', '-'];
	for (let round = 0; round < 3000; round++) {
		const entries = Array.from({ length: 1 + random.int(5) }, (_, index) => {
			// A display name is free text; only angle brackets cannot be written into one, quoted or not.
			const name = random.text(nameAlphabet, 12).replace(/[<>]/g, '').trim();
			const address = `user${round}x${index}@host${random.int(50)}.example`;
			return { name: name || null, address, formatted: name ? app.formatEmailAddress(address, name) : address };
		});
		const header = app.joinEmailAddressList(entries.map(entry => entry.formatted));
		const split = app.splitEmailAddressList(header);
		assert.deepEqual(split, entries.map(entry => entry.formatted), `round ${round}: ${JSON.stringify(header)}`);
		assert.deepEqual(split.map(app.parseEmailAddressParts), entries.map(({ name, address }) => ({ name, address })), `round ${round}: ${JSON.stringify(header)}`);
		assert.deepEqual(app.getEmailAddressList(header), entries.map(entry => entry.address));
		assert.deepEqual(app.parseRecipientEntries(header), entries.map(entry => entry.formatted));
		assert(split.every(app.isValidRecipient));
	}
	for (let round = 0; round < 3000; round++) {
		const garbage = random.text(NASTY, 40);
		try {
			const split = app.splitEmailAddressList(garbage);
			assert(split.every(entry => entry.length > 0 && entry === entry.trim()));
			split.map(app.parseEmailAddressParts);
			const list = app.getEmailAddressList(garbage);
			assert.equal(new Set(list).size, list.length, 'addresses are deduplicated');
			app.parseRecipientEntries(garbage).forEach(app.isValidRecipient);
		} catch (error) { assert.fail(`round ${round}, input ${JSON.stringify(garbage)}: ${error.message}`); }
	}
	assert.deepEqual(app.splitEmailAddressList(null), []);
	assert.deepEqual(app.splitEmailAddressList(undefined), []);
});

test('a pathological header of a megabyte is read in linear time', () => {
	const cases = { quotes: '"'.repeat(1_000_000), angles: '<'.repeat(1_000_000), commas: ','.repeat(1_000_000), backslashes: `"${'\\'.repeat(999_999)}`, spaces: `${' '.repeat(500_000)}a@b.example${' '.repeat(500_000)}`, mixed: 'a"<,;\\>'.repeat(140_000) };
	for (const [name, input] of Object.entries(cases)) {
		const started = performance.now();
		app.getEmailAddressList(input);
		app.splitEmailAddressList(input).slice(0, 100).map(app.parseEmailAddressParts);
		assert(performance.now() - started < 4000, `${name} took ${Math.round(performance.now() - started)} ms`);
	}
	const started = performance.now();
	app.parseEmailAddressParts(`"${'a\\'.repeat(200_000)}`);
	app.parseEmailAddressParts(`${'"x" '.repeat(100_000)}<a@b.example>`);
	app.skeleton('rn'.repeat(500_000));
	app.withinOneEdit('a'.repeat(1_000_000), 'b'.repeat(1_000_000));
	app.registrableDomain('a.'.repeat(500_000));
	assert(performance.now() - started < 4000, `single values took ${Math.round(performance.now() - started)} ms`);
});

const SAMPLE = ['From: "Chen, Maya" <maya@acme.test>', 'To: owner@example.test, =?UTF-8?B?SsO8cmdlbg==?= <j@example.test>', 'Subject: =?UTF-8?Q?Gr=C3=B6=C3=9Fe?= and attachment',
	'Message-ID: <fuzz-1@acme.test>', 'In-Reply-To: <parent@example.test>', 'References: <root@example.test> <parent@example.test>', 'Date: Thu, 26 Nov 2026 10:00:00 +0100',
	'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="outer"', '', '--outer', 'Content-Type: multipart/alternative; boundary="inner"', '',
	'--inner', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Gr=C3=BC=C3=9Fe aus M=C3=BCnchen', '--inner',
	'Content-Type: text/html; charset=iso-8859-1', 'Content-Transfer-Encoding: base64', '', 'PHA+R3L832U8L3A+', '--inner--', '--outer',
	'Content-Type: application/pdf; name="=?UTF-8?B?UmVjaG51bmcucGRm?="', 'Content-Disposition: attachment; filename*=UTF-8\'\'Rechnung%20%C3%A4.pdf', 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--outer--', ''].join('\r\n');

test('the sample message is read as written, so the mutations below start from something real', async () => {
	const parsed = await app.parseRawMime(new TextEncoder().encode(SAMPLE).buffer);
	assert.equal(parsed.subject, 'Größe and attachment');
	assert.match(parsed.fromAddr, /maya@acme\.test/);
	assert.match(parsed.toAddr, /Jürgen/);
	assert.deepEqual(parsed.references, ['root@example.test', 'parent@example.test']);
	assert.match(parsed.text, /Grüße aus München/);
	assert.equal(parsed.attachments.length, 1);
	assert.equal(parsed.attachments[0].filename, 'Rechnung ä.pdf');
});

test('damaged, truncated and hostile MIME is read or refused, never crashes or hangs', async () => {
	const random = generator(1337);
	const bytes = new TextEncoder().encode(SAMPLE);
	const insertions = ['\r\n--outer\r\n', '\r\n--inner--\r\n', 'Content-Type: multipart/mixed; boundary="outer"\r\n', 'Content-Transfer-Encoding: base64\r\n', '=?UTF-8?B?////?=', '=?x-unknown?Q?=FF=FE?=',
		'Content-Type: text/plain; charset=does-not-exist\r\n', `X-Long: ${'a'.repeat(20_000)}\r\n`, 'Content-Type: message/rfc822\r\n\r\n', '\0\0\0', '\r\n\r\n', `${'=?UTF-8?Q?a?= '.repeat(500)}`, 'Content-Type: multipart/mixed; boundary=""\r\n', '<<<<>>>>,,,;;;"""'];
	const started = performance.now();
	let read = 0, refused = 0;
	for (let round = 0; round < 400; round++) {
		let mutated = Array.from(bytes);
		for (let change = 0, changes = 1 + random.int(4); change < changes; change++) {
			const at = random.int(mutated.length + 1);
			switch (random.int(5)) {
				case 0: mutated = mutated.slice(0, at); break;
				case 1: mutated.splice(at, random.int(60)); break;
				case 2: mutated[Math.min(at, mutated.length - 1)] = random.int(256); break;
				case 3: mutated.splice(at, 0, ...new TextEncoder().encode(random.pick(insertions))); break;
				default: mutated.splice(at, 0, ...mutated.slice(random.int(mutated.length), random.int(mutated.length) + random.int(200)));
			}
		}
		try {
			const parsed = await app.parseRawMime(new Uint8Array(mutated).buffer);
			assert.equal(typeof parsed, 'object');
			assert(Array.isArray(parsed.attachments) && Array.isArray(parsed.references), `round ${round}`);
			assert(parsed.date === null || !Number.isNaN(parsed.date.getTime()), `round ${round}: date`);
			for (const key of ['subject', 'fromAddr', 'toAddr', 'ccAddr', 'replyTo', 'messageId', 'inReplyTo', 'text', 'html']) assert(parsed[key] === null || parsed[key] === undefined || typeof parsed[key] === 'string', `round ${round}: ${key}`);
			assert.equal(typeof app.buildSnippet(parsed.text ?? null, parsed.html ?? null), 'string');
			read++;
		} catch (error) {
			// Refusing a message is fine; the queue retries or dead-letters it. Only a real Error may come out.
			assert(error instanceof Error, `round ${round} threw a non-error: ${String(error)}`);
			refused++;
		}
	}
	assert(read > 300, `most damaged messages are still readable: ${read} read, ${refused} refused`);
	assert(performance.now() - started < 60_000, 'no mutation made the reader hang');
});

test('a JMAP filter from any client is translated or refused with a JMAP error, never dropped by a crash', () => {
	const random = generator(8620);
	const accessible = new Set(['box']);
	const values = [undefined, null, true, false, 0, -1, 1e308, Number.NaN, '', 'x', 'box', 'box~inbox', '%_\\', '2026-11-26T00:00:00Z', 'not a date', [], ['Message-ID'], ['Message-ID', '<a@b>'], ['Subject', 'x'], [1, 2], ['a', 'b', 'c'], {}, { nested: true }, '$seen', '$flagged', '$unknown', 'a'.repeat(5000)];
	const keys = ['inMailbox', 'inMailboxOtherThan', 'before', 'after', 'minSize', 'maxSize', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword', 'noneInThreadHaveKeyword', 'hasKeyword', 'notKeyword', 'hasAttachment', 'text', 'from', 'to', 'cc', 'bcc', 'subject', 'body', 'header'];
	const condition = () => Object.fromEntries(Array.from({ length: random.int(4) }, () => [random.pick(keys), random.pick(values)]));
	const filter = depth => depth > 2 || random.int(3) > 0 ? condition() : { operator: random.pick(['AND', 'OR', 'NOT', 'XOR', undefined, 5]), conditions: random.int(8) === 0 ? random.pick(values) : Array.from({ length: random.int(4) }, () => filter(depth + 1)) };
	let refused = 0, translated = 0;
	for (let round = 0; round < 6000; round++) {
		const candidate = filter(0);
		try { app.filterToSql(candidate, accessible); translated++; }
		catch (error) {
			assert(error instanceof app.JmapError, `round ${round}, filter ${JSON.stringify(candidate)}: ${error?.constructor?.name}: ${error?.message}`);
			refused++;
		}
	}
	assert(translated > 500 && refused > 500, `both outcomes are exercised: ${translated} translated, ${refused} refused`);
});

test('a JMAP condition is never silently ignored: unknown properties and wrong types are refused by name', () => {
	const accessible = new Set(['box']);
	const type = filter => { try { app.filterToSql(filter, accessible); return 'accepted'; } catch (error) { return error instanceof app.JmapError ? error.type : `crash: ${error}`; } };
	// Ignoring a condition would widen "these messages" to "every message in the account".
	assert.equal(type({ sentBefore: '2026-01-01T00:00:00Z' }), 'unsupportedFilter');
	assert.equal(type({ from: 'maya', isUnread: true }), 'unsupportedFilter');
	assert.equal(type({ __proto__: null, constructor: 'x' }), 'unsupportedFilter');
	assert.equal(type({ before: 'yesterday' }), 'invalidArguments');
	assert.equal(type({ before: '' }), 'invalidArguments');
	assert.equal(type({ minSize: '10' }), 'invalidArguments');
	assert.equal(type({ maxSize: -1 }), 'invalidArguments');
	assert.equal(type({ from: 5 }), 'invalidArguments');
	assert.equal(type({ hasAttachment: 'yes' }), 'invalidArguments');
	assert.equal(type({ inMailbox: [] }), 'invalidArguments');
	assert.equal(type({ inMailboxOtherThan: 'box' }), 'invalidArguments');
	assert.equal(type({ operator: 'AND', conditions: 'from:maya' }), 'invalidArguments');
	assert.equal(type({ operator: 'XOR', conditions: [{ from: 'maya' }] }), 'invalidArguments');
	assert.equal(type('from:maya'), 'invalidArguments');
	assert.equal(type([{ from: 'maya' }]), 'invalidArguments');
	// A client that writes null for "not set" keeps working, and real conditions are accepted.
	assert.equal(app.filterToSql({ text: null, inMailbox: null, hasAttachment: null }, accessible), undefined);
	assert.equal(type({ from: 'maya', hasAttachment: false, minSize: 0, before: '2026-11-26T00:00:00Z', header: ['Message-ID', '<a@b.test>'] }), 'accepted');
	assert.equal(type({ operator: 'NOT', conditions: [{ operator: 'OR', conditions: [{ subject: 'a' }, { hasKeyword: '$seen' }] }] }), 'accepted');
	// A filter nested ten thousand deep is refused, not followed until the stack runs out.
	let deep = { from: 'maya' };
	for (let level = 0; level < 10_000; level++) deep = { operator: 'AND', conditions: [deep] };
	assert.equal(type(deep), 'invalidArguments');
});
