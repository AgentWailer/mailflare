// A Mailflare for the simulator to talk to: the built Worker over a local database and bucket
// filled with made-up mail. Nothing here touches production or needs credentials.
//
//   npm run build                              (once, and after server changes)
//   node ios/tools/local-server.mjs            (runs until stopped)
//
// In the app: server http://127.0.0.1:8799, any access key (nothing checks it locally),
// sign in as anna@example.test or admin@example.test with the password printed below.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import bcrypt from 'bcryptjs';

const root = process.cwd();
const port = Number(process.env.PORT ?? 8799);
assert(existsSync('dist/server/wrangler.json'), 'Run "npm run build" first.');
const built = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
const database = built.d1_databases.find((item) => item.binding === 'DB');
const bucket = built.r2_buckets.find((item) => item.binding === 'BUCKET');
for (const file of ['.dev.vars', 'dist/server/.dev.vars']) assert(!existsSync(file), `${file} would bring local secrets into this fixture`);

const temporary = mkdtempSync(join(tmpdir(), 'mailflare-ios-server-'));
const state = join(temporary, 'state');
const configPath = join(temporary, 'wrangler.json');
writeFileSync(configPath, JSON.stringify({
	name: 'mailflare-ios-fixture',
	compatibility_date: built.compatibility_date,
	d1_databases: [{binding: 'DB', database_name: 'ios-fixture', database_id: database.database_id, migrations_dir: resolve('drizzle/migrations')}],
	r2_buckets: [{binding: 'BUCKET', bucket_name: bucket.bucket_name}],
}));
const env = {...process.env, XDG_CONFIG_HOME: temporary, CLOUDFLARE_REMOTE_BINDINGS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false', MAILFLARE_LOCAL_STATE_PATH: state};
for (const key of Object.keys(env)) if (/^(CF_|CLOUDFLARE_API_|TURNSTILE_|NEXT_PUBLIC_TURNSTILE_|AWS_|R2_)/.test(key)) delete env[key];

async function wrangler(args) {
	const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', configPath, '--persist-to', state], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
	let output = '';
	for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
	const [code] = await once(child, 'exit');
	assert.equal(code, 0, `Local fixture command failed: ${output.slice(-4000)}`);
}

const password = 'Simulator fixture password!';
const hash = bcrypt.hashSync(password, 10);
const now = Math.floor(Date.now() / 1000);
const quote = (value) => (value === null || value === undefined ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'");

const messages = [];
const add = (id, fields) => messages.push({
	id, user: 'anna', mailbox: 'box-anna', direction: 'inbound', from: 'Sender <sender@example.org>', to: 'anna@example.test', cc: null,
	subject: 'Note', snippet: null, text: null, html: null, status: 'received', category: 'primary', read: 0, starred: 0, thread: null, snoozed: null, age: 0, ...fields,
});

add('m-termin-1', {from: 'Anna Krüger <anna.krueger@example.org>', subject: 'Termin am Donnerstag', text: 'Hallo,\n\npasst dir Donnerstag um 14 Uhr? Ich bringe die Unterlagen mit.\n\nViele Grüße\nAnna', thread: 't-termin', read: 1, age: 3 * 3600});
add('m-termin-2', {direction: 'outbound', from: 'anna@example.test', to: 'Anna Krüger <anna.krueger@example.org>', subject: 'Re: Termin am Donnerstag', status: 'sent', read: 1, thread: 't-termin', age: 2 * 3600,
	html: '<p>Hallo Anna,</p><p>ja, 14 Uhr passt gut.</p><div class="mailflare-quote" data-mailflare-quote="1"><p>Am Donnerstag schrieb Anna Krüger:</p><blockquote>passt dir Donnerstag um 14 Uhr? Ich bringe die Unterlagen mit.</blockquote></div>'});
add('m-termin-3', {from: 'Anna Krüger <anna.krueger@example.org>', subject: 'Re: Termin am Donnerstag', text: 'Prima, dann bis Donnerstag. Die Unterlagen hängen an.', thread: 't-termin', starred: 1, age: 20 * 60});
add('m-newsletter', {from: 'Stadtbibliothek <newsletter@bibliothek.example>', subject: 'Neu im Dezember: Lesungen und Öffnungszeiten', category: 'promotions', age: 5 * 3600,
	html: '<html><head><style>.hero{background:#0b57d0;color:#fff;padding:24px;border-radius:12px}h1{margin:0 0 8px}</style></head><body><div class="hero"><h1>Dezember in der Bibliothek</h1><p>Lesungen, Bastelnachmittage und neue Öffnungszeiten.</p></div><p><img src="https://images.example.invalid/lesung.jpg" alt="Lesung im Lesesaal" width="560"></p><table width="100%" cellpadding="8"><tr><td><b>5. Dezember</b></td><td>Krimilesung mit Musik</td></tr><tr><td><b>12. Dezember</b></td><td>Bastelnachmittag für Kinder</td></tr></table><p><a href="https://example.org/programm">Zum ganzen Programm</a></p><script>document.title="x"</script></body></html>'});
add('m-rechnung', {from: 'Stadtwerke <service@stadtwerke.example>', subject: 'Ihre Abrechnung für November', category: 'invoices', text: 'Guten Tag,\n\nanbei erhalten Sie Ihre Abrechnung für November.\nDer Betrag von 84,20 € wird am 5. Dezember abgebucht.\n\nMehr dazu: https://example.org/abrechnung.', age: 26 * 3600});
add('m-bahn', {from: 'Deutsche Bahn <buchung@bahn.example>', subject: 'Ihre Buchung nach Hamburg', category: 'orders', read: 1, text: 'Vielen Dank für Ihre Buchung.\nHinfahrt: 9. Dezember, 08:12 Uhr.', age: 30 * 3600});
add('m-kita', {from: 'Kita Sonnenschein <leitung@kita.example>', subject: 'Elternabend am 9. Dezember', read: 1, text: 'Liebe Eltern,\n\nam 9. Dezember um 19 Uhr findet unser Elternabend statt.', age: 3 * 86400});
add('m-angebot', {from: '"Hahn, Markus" <markus.hahn@dachbau.example>', subject: 'Angebot Dach', read: 1, text: 'Sehr geehrte Frau Beispiel,\n\nanbei das überarbeitete Angebot.', age: 4 * 86400});
add('m-snoozed', {from: 'Versicherung <service@versicherung.example>', subject: 'Unterlagen nachreichen', snoozed: now + 2 * 86400, text: 'Bitte reichen Sie die Unterlagen bis Monatsende nach.', age: 2 * 86400});
add('m-spoof', {from: '"service@bank.example" <angreifer@boese.example>', subject: 'Ihr Konto wurde gesperrt', text: 'Bitte bestätigen Sie Ihre Daten.', status: 'spam', age: 6 * 3600});
add('m-draft', {direction: 'outbound', from: 'anna@example.test', to: '', subject: '', status: 'draft', read: 1, text: 'Angefangen …', age: 3600});
add('m-team', {user: 'admin', mailbox: 'box-team', to: 'team@example.test', from: 'Kundin <kundin@example.org>', subject: 'Frage zur Bestellung', text: 'Guten Tag, wann wird meine Bestellung geliefert?', age: 90 * 60});
add('m-old', {from: 'Archivar <archiv@example.org>', subject: 'Älter als das Offline-Fenster', read: 1, text: 'Diese Mail ist 45 Tage alt.', age: 45 * 86400});
for (let i = 0; i < 70; i++) {
	add('m-bulk-' + String(i).padStart(2, '0'), {from: `Absender ${i + 1} <absender${i + 1}@example.org>`, subject: `Rundschreiben Nr. ${i + 1}`, read: i % 3 === 0 ? 0 : 1, text: `Dies ist das Rundschreiben Nr. ${i + 1}.`, age: 5 * 86400 + i * 7200});
}

const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 52>>stream\nBT /F1 18 Tf 40 110 Td (Unterlagen zum Termin) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

const sql = `
INSERT INTO users (id,email,password_hash,name,role,is_primary_admin,created_at) VALUES ('anna','anna@example.test',${quote(hash)},'Anna Beispiel','user',0,${now}),('admin','admin@example.test',${quote(hash)},'Admin Beispiel','admin',1,${now});
INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','admin','example.test','synthetic-local-zone','active',${now});
INSERT INTO mailboxes (id,user_id,domain_id,local_part,display_name,type,created_at) VALUES ('box-anna','anna','domain','anna','Anna Beispiel','personal',${now}),('box-admin','admin','domain','admin','Admin Beispiel','personal',${now}),('box-team','admin','domain','team','Team','shared',${now});
INSERT INTO mailbox_access (id,user_id,mailbox_id,permission,created_at) VALUES ('access-anna-team','anna','box-team','read_only',${now});
INSERT INTO folders (id,user_id,mailbox_id,name,color,created_at) VALUES ('folder-haus','anna','box-anna','Haus','#16a34a',${now});
INSERT INTO contacts (id,user_id,email,display_name,source,created_at) VALUES ('contact-anna','anna','anna.krueger@example.org','Anna Krüger','manual',${now});
${messages.map((m) => `INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,subject,snippet,text_body,html_body,status,category,read,starred,thread_id,snoozed_until,created_at) VALUES (${[m.id, m.user, m.mailbox, m.direction, m.from, m.to, m.cc, m.subject, m.snippet ?? (m.text ?? '').replace(/\s+/g, ' ').slice(0, 140), m.text, m.html, m.status, m.category].map(quote).join(',')},${m.read},${m.starred},${quote(m.thread)},${m.snoozed ?? 'NULL'},${now - m.age});`).join('\n')}
INSERT INTO message_labels (message_id,folder_id) VALUES ('m-angebot','folder-haus');
INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,disposition,created_at) VALUES ('att-unterlagen','m-termin-3','Unterlagen.pdf','application/pdf',${Buffer.byteLength(pdf)},'fixture/att-unterlagen','attachment',${now});
`;

let preview;
const stop = () => { preview?.kill('SIGTERM'); rmSync(temporary, {recursive: true, force: true}); };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
try {
	await wrangler(['d1', 'migrations', 'apply', 'DB', '--local']);
	const sqlPath = join(temporary, 'fixture.sql');
	writeFileSync(sqlPath, sql);
	await wrangler(['d1', 'execute', 'DB', '--local', '--file', sqlPath]);
	const pdfPath = join(temporary, 'Unterlagen.pdf');
	writeFileSync(pdfPath, pdf);
	await wrangler(['r2', 'object', 'put', `${bucket.bucket_name}/fixture/att-unterlagen`, '--local', '--file', pdfPath, '--content-type', 'application/pdf']);
	preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {cwd: root, env, stdio: ['ignore', 'inherit', 'inherit']});
	for (let attempt = 0; ; attempt++) {
		assert(attempt < 240, 'The server did not come up');
		assert(preview.exitCode === null, 'The server exited');
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {signal: AbortSignal.timeout(1000)});
			await response.body?.cancel();
			if (response.status === 401) break;
		} catch { /* not up yet */ }
		await new Promise((done) => setTimeout(done, 250));
	}
	console.log(`\nMailflare fixture ready: http://127.0.0.1:${port}\n  anna@example.test / admin@example.test, password: ${password}\n  ${messages.length} messages. Stop with Ctrl-C.\n`);
	await once(preview, 'exit');
} finally {
	stop();
}
