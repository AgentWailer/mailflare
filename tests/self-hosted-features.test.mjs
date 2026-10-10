import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-fork-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { getDb } from "./src/db/index.ts";
			export { getMailboxAccessLevel, listAccessibleMailboxes } from "./src/lib/mailboxes/access.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { getLicenseEntitlements } from "./src/lib/licenses/service.ts";
			export { getAccountSeatError } from "./src/lib/licenses/seats.ts";
			export { canShareAdminMailboxes } from "./src/lib/api/admin-auth.ts";
			export { GET as accounts } from "./src/app/api/accounts/route.ts";
			export { PUT as branding } from "./src/app/api/branding/route.ts";
			export { GET as updateStatus } from "./src/app/api/admin/update/GET.ts";
			export { POST as update } from "./src/app/api/admin/update/POST.ts";
			export { dispatchUpdateWorkflow } from "./src/app/api/admin/update/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "self-hosted-features-entry.ts",
	},
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm",
	target: "node24", packages: "external", tsconfig: join(root, "tsconfig.json"),
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new app.SqliteDatabase(":memory:");
	t.after(() => { database.db.close(); delete globalThis.__mailflareNodeEnv; });
	await app.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id,email,password_hash,name,role,is_primary_admin,created_at) VALUES
		('owner','owner@example.test','hash','Owner','admin',1,1),
		('member','member@example.test','hash','Member','user',0,1),
		('admin','admin@example.test','hash','Admin','admin',0,1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	const tokens = {};
	for (const id of ['owner', 'member', 'admin']) tokens[id] = await app.createSession(env, id);
	const request = (path, user, init = {}) => new Request(`https://mailflare.test${path}`, {
		...init, headers: { Authorization: `Bearer ${tokens[user] ?? 'invalid-session'}` },
	});
	return { database, env, request };
}

test("all bundled features work without reading a license database or contacting Paymug", async (t) => {
	t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected external call"); });
	const env = new Proxy({}, { get() { throw new Error("License binding must not be needed"); } });
	const grants = await app.getLicenseEntitlements(env);
	assert.equal(grants.canCustomizeBranding, true);
	assert.equal(grants.canManageAccounts, true);
	assert.equal(grants.canShareMailboxes, true);
	assert.equal(grants.canForwardEmail, true);
	assert.equal(grants.accountSeatLimit, null);
	assert.equal(await app.getAccountSeatError(env), null);
	assert.equal(await app.canShareAdminMailboxes(env), true);
});

test("an unlicensed owner can list accounts with no seat limit; normal users cannot", async (t) => {
	const f = await fixture(t);
	const response = await app.accounts(f.request('/api/accounts', 'owner'));
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.accounts.length, 3);
	assert.equal(data.seats.limit, null);
	assert.equal((await app.accounts(f.request('/api/accounts', 'member'))).status, 403);
	assert.equal((await app.accounts(f.request('/api/accounts', 'unknown'))).status, 403);
	assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM license_settings').get().n, 0);
});

test("branding saves without a license, while only the primary admin may change it", async (t) => {
	const f = await fixture(t);
	const form = new FormData(); form.set('appName', 'Our Mail');
	for (const user of ['member', 'admin', 'unknown']) {
		assert.equal((await app.branding(f.request('/api/branding', user, { method: 'PUT', body: form }))).status, 403);
	}
	const response = await app.branding(f.request('/api/branding', 'owner', { method: 'PUT', body: form }));
	assert.equal(response.status, 200);
	assert.equal((await response.json()).appName, 'Our Mail');
	assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM license_settings').get().n, 0);
});

test("expired purchased license data is preserved and cannot restrict fork capabilities", async (t) => {
	const f = await fixture(t);
	f.database.db.exec("INSERT INTO license_settings (id,instance_id,plan,state,seat_limit,updated_at) VALUES ('default','existing','pro','expired',1,1)");
	const before = f.database.db.prepare('SELECT * FROM license_settings').get();
	const grants = await app.getLicenseEntitlements(f.env);
	assert.equal(grants.canShareMailboxes, true);
	assert.equal(grants.accountSeatLimit, null);
	assert.equal(await app.getAccountSeatError(f.env), null);
	assert.deepEqual(f.database.db.prepare('SELECT * FROM license_settings').get(), before);
});

test("automatic upstream updates are blocked even with configured credentials, preserving authorization", async (t) => {
	const f = await fixture(t);
	Object.assign(f.env, { GITHUB_UPDATE_TOKEN: 'test-only', GITHUB_UPDATE_REPO: 'AgentWailer/mailflare' });
	t.mock.method(globalThis, "fetch", () => { throw new Error("Must not dispatch a workflow"); });
	assert.equal((await app.update(f.request('/api/admin/update', 'unknown', { method: 'POST' }))).status, 401);
	for (const user of ['member', 'admin']) assert.equal((await app.update(f.request('/api/admin/update', user, { method: 'POST' }))).status, 403);
	const response = await app.update(f.request('/api/admin/update', 'owner', { method: 'POST' }));
	assert.equal(response.status, 409);
	assert.match((await response.json()).error, /disabled/);
	const status = await app.updateStatus(f.request('/api/admin/update', 'owner'));
	assert.equal(status.status, 200);
	const data = await status.json();
	assert.equal(data.manualOnly, true); assert.equal(data.available, false);
	await assert.rejects(app.dispatchUpdateWorkflow(), /disabled/);
});


test("shared mailbox members retain only their delegated permissions without a Team key", async (t) => {
	const f = await fixture(t);
	f.database.db.exec(`
		INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','manual','active',1);
		INSERT INTO mailboxes (id,user_id,domain_id,local_part,type,created_at) VALUES
		('shared','owner','domain','shared','shared',1),
		('personal','owner','domain','private','personal',1);
		INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('grant','shared','member','read_only',1);
	`);
	const db = app.getDb(f.env);
	const member = { id: 'member', role: 'user', email: 'member@example.test' };
	const delegated = await app.getMailboxAccessLevel(db, member, 'shared');
	assert.equal(delegated.canRead, true);
	assert.equal(delegated.canSendAs, false);
	assert.equal(delegated.canSendOnBehalf, false);
	assert.equal(delegated.canManage, false);
	assert.equal(await app.getMailboxAccessLevel(db, member, 'personal'), null);
	assert.equal(await app.getMailboxAccessLevel(db, { id: 'admin', role: 'admin' }, 'shared'), null);
	assert.deepEqual((await app.listAccessibleMailboxes(db, member)).map(m => m.id), ['shared']);
	f.database.db.exec("DELETE FROM mailbox_access");
	assert.equal(await app.getMailboxAccessLevel(db, member, 'shared'), null);
	assert.deepEqual(await app.listAccessibleMailboxes(db, member), []);
});
