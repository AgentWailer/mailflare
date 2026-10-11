import assert from "node:assert/strict";
import test, { after } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server.js";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(process.cwd(), "node_modules", "mailflare-domain-admin-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "headers.mjs"), "export async function cookies(){return {get:()=>undefined};}");
writeFileSync(join(dir, "dns.mjs"), `
 const dns={routing:{records:[],missing:[],status:'manual'},sending:[],sendingEnabled:false};
 export const getManualDomainDns=async()=>dns;
 export const getDomainDnsView=async()=>dns;
 export const summariseDomainDns=async()=>({summary:{routing:{configured:true,missing:[]},sending:{configured:false,records:[]}},sendingEnabled:false});
`);
await build({
	stdin: { contents: `
	 export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
	 export {applyMigrations} from './server/runtime/migrate.ts';
	 export {createSession} from './src/lib/auth/session.ts';
	 export {generateApiKey} from './src/lib/api-keys.ts';
	 export {GET as listDomains,POST as addDomain} from './src/app/api/domains/route.ts';
	 export {GET as domainDetails,DELETE as removeDomain} from './src/app/api/domains/[id]/route.ts';
	 export {GET as dnsDetails} from './src/app/api/domains/[id]/dns/route.ts';
	 export {PUT as changeReceiving} from './src/app/api/domains/[id]/receiving/route.ts';
	 export {PUT as changeSending} from './src/app/api/domains/[id]/sending/route.ts';
	 export {GET as listV1,POST as addV1} from './src/app/api/v1/domains/route.ts';
	 export {GET as detailV1,DELETE as removeV1} from './src/app/api/v1/domains/[id]/route.ts';
	 export {GET as dnsV1} from './src/app/api/v1/domains/[id]/dns/route.ts';
	`, resolveDir: process.cwd() },
	outfile: join(dir, "app.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: "tsconfig.json",
	alias: { "next/headers": join(dir, "headers.mjs"), "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts", "@/lib/domains/manual-dns": join(dir, "dns.mjs"), "@/lib/domains/dns-view": join(dir, "dns.mjs") },
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(dir, "app.mjs")).href);
async function fixture(t) {
	const DB = new app.SqliteDatabase(":memory:");
	t.after(() => { DB.db.close(); delete globalThis.__mailflareNodeEnv; });
	await app.applyMigrations(DB, join(process.cwd(), "drizzle/migrations"));
	DB.db.exec(`
	 INSERT INTO users(id,email,password_hash,name,role,created_at,disabled,is_primary_admin,can_manage_mailboxes,can_manage_domains,created_by_user_id) VALUES
	 ('owner','old@example.test','hash','Former owner','admin',1,1,0,0,0,NULL),
	 ('delegate','admin@example.test','hash','Current administrator','admin',1,0,1,1,1,'owner'),
	 ('member','member@example.test','hash','Member','user',1,0,0,0,0,'owner'),
	 ('foreign','foreign@example.test','hash','Independent administrator','admin',1,0,1,0,0,NULL);
	 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES
	 ('shared','owner','shared.test','manual','active',1),('private','foreign','private.test','manual','active',1);
	`);
	globalThis.__mailflareNodeEnv = { DB, MAILFLARE_RUNTIME: "node" };
	const sessions = {}, keys = {};
	for (const id of ["delegate", "member", "foreign"]) {
		sessions[id] = await app.createSession(globalThis.__mailflareNodeEnv, id);
		const key = app.generateApiKey();
		DB.db.prepare("INSERT INTO api_keys(id,user_id,name,prefix,key_hash,scopes,created_at) VALUES(?,?,?,?,?,?,1)").run("key-" + id, id, "Test", key.prefix, key.hash, '["domains"]');
		keys[id] = key.fullKey;
	}
	const request = (method = "GET", body, user = "delegate", v1 = false) => new Request("https://mailflare.test/api/domains", {
		method, headers: { Authorization: "Bearer " + (v1 ? keys[user] : sessions[user]), "Content-Type": "application/json" },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	return { DB, request };
}
const params = id => ({ params: Promise.resolve({ id }) });
const createInput = hostname => ({ hostname, enableRouting: false, sendingProvider: "none", receivingProvider: "none" });

test("new domain stays visible when the current administrator uses the former owner's registry", async t => {
	const { DB, request } = await fixture(t);
	const added = await app.addDomain(request("POST", createInput("new.test")));
	assert.equal(added.status, 200);
	const { domain } = await added.json();
	assert.equal(domain.userId, "owner");
	assert.equal(DB.db.prepare("SELECT COUNT(*) AS count FROM domains WHERE user_id='delegate'").get().count, 0);
	const listed = await app.listDomains(new NextRequest("https://mailflare.test/api/domains?includeDns=true", { headers: request().headers }));
	assert.deepEqual((await listed.json()).domains.map(d => d.hostname).sort(), ["new.test", "shared.test"]);
	assert.equal((await app.domainDetails(request(), params(domain.id))).status, 200);
	assert.equal((await app.dnsDetails(request(), params(domain.id))).status, 200);
	assert.equal((await app.changeReceiving(request("PUT", { provider: "none" }), params(domain.id))).status, 200);
	assert.equal((await app.changeSending(request("PUT", { provider: "none" }), params(domain.id))).status, 200);
	assert.equal((await app.removeDomain(request("DELETE"), params(domain.id))).status, 200);
	assert.equal(DB.db.prepare("SELECT COUNT(*) AS count FROM domains WHERE id=?").get(domain.id).count, 0);
});

test("independent administrators keep their own registry and cannot read or mutate another registry", async t => {
	const { DB, request } = await fixture(t);
	assert.equal((await app.domainDetails(request("GET", undefined, "delegate"), params("private"))).status, 404);
	assert.equal((await app.domainDetails(request("GET", undefined, "foreign"), params("shared"))).status, 404);
	assert.equal((await app.changeReceiving(request("PUT", { provider: "none" }, "delegate"), params("private"))).status, 404);
	assert.equal((await app.addDomain(request("POST", createInput("shared.test"), "foreign"))).status, 400);
	assert.equal(DB.db.prepare("SELECT user_id FROM domains WHERE id='shared'").get().user_id, "owner");
	const added = await app.addDomain(request("POST", createInput("foreign-new.test"), "foreign"));
	assert.equal(added.status, 200);
	assert.equal((await added.json()).domain.userId, "foreign");
});

test("ordinary accounts and missing sessions cannot add domains to the shared registry", async t => {
	const { request } = await fixture(t);
	assert.equal((await app.addDomain(request("POST", createInput("blocked.test"), "member"))).status, 403);
	assert.equal((await app.addDomain(new Request("https://mailflare.test/api/domains", { method: "POST" }))).status, 401);
});

test("admin API keys use the same domain registry for add, list, detail, DNS and delete", async t => {
	const { request } = await fixture(t);
	const added = await app.addV1(request("POST", createInput("api-new.test"), "delegate", true));
	assert.equal(added.status, 200);
	const { domain } = await added.json();
	assert.equal(domain.userId, "owner");
	const listed = await app.listV1(request("GET", undefined, "delegate", true));
	assert((await listed.json()).domains.some(d => d.id === domain.id));
	assert.equal((await app.detailV1(request("GET", undefined, "delegate", true), params(domain.id))).status, 200);
	assert.equal((await app.dnsV1(request("GET", undefined, "delegate", true), params(domain.id))).status, 200);
	assert.equal((await app.detailV1(request("GET", undefined, "foreign", true), params(domain.id))).status, 404);
	assert.equal((await app.removeV1(request("DELETE", undefined, "delegate", true), params(domain.id))).status, 200);
});
