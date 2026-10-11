import assert from "node:assert/strict";
import test, { after } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(process.cwd(), "node_modules", "mailflare-catch-all-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "headers.mjs"), "export async function cookies(){return {get:()=>undefined};}");
await build({
	stdin: {
		contents: `
			export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
			export {applyMigrations} from './server/runtime/migrate.ts';
			export {getDb} from './src/db/index.ts';
			export {createSession} from './src/lib/auth/session.ts';
			export {resolveInboundAddress} from './src/lib/email/routing.ts';
			export {intakeIncomingMail} from './src/lib/email/intake.ts';
			export {processInboundMessage} from './src/lib/email/inbound.ts';
			export {GET as listRules, POST as createRule} from './src/app/api/routing-rules/domain/route.ts';
			export {PATCH as updateRule} from './src/app/api/routing-rules/domain/[id]/route.ts';
			export {describeRule} from './src/components/settings/domain-routing/utils.ts';
		`,
		resolveDir: process.cwd(),
	},
	outfile: join(dir, "app.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	tsconfig: "tsconfig.json",
	alias: {
		"next/headers": join(dir, "headers.mjs"),
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(dir, "app.mjs")).href);
const hostnames = ["aperturo.test", "stepo-data.test", "vonlindern.test", "central.test"];
async function fixture(t) {
	const DB = new app.SqliteDatabase(":memory:");
	t.after(() => { DB.db.close(); delete globalThis.__mailflareNodeEnv; });
	await app.applyMigrations(DB, join(process.cwd(), "drizzle/migrations"));
	DB.db.exec(`
		INSERT INTO users(id,email,password_hash,name,role,created_at,spam_protection_enabled) VALUES
		('admin','admin@central.test','hash','Admin','admin',1,0),
		('owner','mail@central.test','hash','Mailbox owner','user',1,0),
		('foreign','foreign@private.test','hash','Foreign admin','admin',1,0);
		INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES
		('aperturo','admin','aperturo.test','manual','active',1),
		('stepo','admin','stepo-data.test','manual','active',1),
		('vonlindern','admin','vonlindern.test','manual','active',1),
		('central','admin','central.test','manual','active',1),
		('private','foreign','private.test','manual','active',1);
		INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at,use_all_domains,disabled) VALUES
		('box','owner','central','mail','personal',1,1,0),
		('test','owner','stepo','test','personal',1,0,1),
		('privatebox','foreign','private','mail','personal',1,0,0);
		INSERT INTO mailbox_aliases(id,domain_id,mailbox_id,local_part,created_at) VALUES ('alias','central','box','paypal',1);
		INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES
		('aperturo-label','owner','box','Aperturo',1),('stepo-label','owner','box','Stepo',1);
	`);
	for (const domain of ["aperturo", "stepo", "vonlindern", "central"])
		DB.db.prepare(`INSERT INTO routing_rules(id,user_id,domain_id,scope,pattern,match_field,match_operator,match_value,action,mailbox_id,enabled,priority,created_at)
		VALUES(?,'admin',?,'domain','*','recipient','contains','*','store','box',1,100,1)`).run("catch-" + domain, domain);
	for (const [domain, label] of [["aperturo", "aperturo-label"], ["stepo-data", "stepo-label"]]) {
		const value = "@" + domain + ".test";
		DB.db.prepare(`INSERT INTO routing_rules(id,user_id,domain_id,scope,pattern,match_field,match_operator,match_value,action,mailbox_id,enabled,priority,conditions,label_ids,created_at)
		VALUES(?,'owner','central','mailbox',?,'recipient','ends_with',?,'store','box',1,10,?,?,1)`)
			.run("label-" + domain, value, value, JSON.stringify([{field:"recipient",operator:"ends_with",value,negate:false}]), JSON.stringify([label]));
	}
	const events = [], objects = new Map(), queued = [];
	let aiCalls = 0;
	const env = {
		DB,
		MAILFLARE_RUNTIME: "node",
		AI: { run: async () => { aiCalls++; return {answers: {
			category: {type:"choice",choice:"promotions",probabilities:{primary:0.02,promotions:0.95,social:0.02,spam:0.01}},
			action: {type:"noul",noul:0.01}, security:{type:"noul",noul:0.01},
		}}; } },
		BUCKET: {
			put: async (key, bytes) => { objects.set(key, bytes); },
			get: async (key) => objects.has(key) ? {arrayBuffer:async()=>objects.get(key)} : null,
		},
		INBOUND_QUEUE: {send: async (payload) => { queued.push(payload); }},
		REALTIME: {getByName:()=>({fetch:async(_url,init)=>{events.push(JSON.parse(init.body));return new Response();}})},
	};
	globalThis.__mailflareNodeEnv = env;
	const tokens = {};
	for (const id of ["admin", "owner", "foreign"]) tokens[id] = await app.createSession(env, id);
	const request = (path, method = "GET", body, user = "admin") => new Request("https://mailflare.test" + path, {
		method, headers:{Authorization:"Bearer " + tokens[user],"Content-Type":"application/json"},
		...(body ? {body:JSON.stringify(body)} : {}),
	});
	return {DB,env,db:app.getDb(env),request,events,objects,queued,aiCalls:()=>aiCalls};
}
const ruleInput = (overrides = {}) => ({
	domainId:"aperturo",name:"Central catch-all",enabled:true,matchField:"recipient",matchOperator:"contains",
	matchValue:"*",action:"store",mailboxId:"box",keepCopy:false,priority:100,...overrides,
});

test("all four catch-alls, aliases and the former exact test address deliver to one central mailbox", async (t) => {
	const f = await fixture(t);
	for (const hostname of hostnames) {
		for (const localPart of ["mail", "unknown", "sales+tag", "UPPERCASE"]) {
			const address = localPart + "@" + hostname.toUpperCase();
			const decision = await app.resolveInboundAddress(f.db, address, "sender@example.test");
			assert.equal(decision?.action, "store", address);
			assert.equal(decision?.mailbox?.mailboxId, "box", address);
			assert.equal(decision?.mailbox?.userId, "owner", address);
			assert.ok(!decision?.forwardTo, address);
		}
	}
	for (const address of ["test@stepo-data.test", "paypal@central.test"])
		assert.equal((await app.resolveInboundAddress(f.db,address))?.mailbox?.mailboxId,"box");
	assert.equal(await app.resolveInboundAddress(f.db,"test@not-our-domain.test"),null);
});

test("admin can create and edit cross-domain delivery only within the same domain ownership", async (t) => {
	const f = await fixture(t);
	const choices = await app.listRules(f.request("/api/routing-rules/domain?domainId=aperturo"));
	assert.equal(choices.status,200);
	const data = await choices.json();
	assert.equal(data.mailboxes.find(m=>m.id==="box").hostname,"central.test");
	assert.ok(!data.mailboxes.some(m=>m.id==="privatebox"));
	assert.match(app.describeRule(data.rules[0],data.mailboxes,"aperturo.test"),/mail@central\.test/);
	const created = await app.createRule(f.request("/api/routing-rules/domain","POST",ruleInput()));
	assert.equal(created.status,200);
	const {id} = await created.json();
	assert.equal((await app.updateRule(f.request("/api/routing-rules/domain/"+id,"PATCH",ruleInput({name:"Edited"})),{params:Promise.resolve({id})})).status,200);
	assert.equal((await app.createRule(f.request("/api/routing-rules/domain","POST",ruleInput({mailboxId:"privatebox"})))).status,403);
	assert.equal((await app.updateRule(f.request("/api/routing-rules/domain/"+id,"PATCH",ruleInput({mailboxId:"privatebox"})),{params:Promise.resolve({id})})).status,403);
	assert.equal((await app.listRules(f.request("/api/routing-rules/domain?domainId=aperturo","GET",undefined,"foreign"))).status,403);
	// Mailbox-level access must not inherit the domain administrator's wider rights.
	assert.equal((await app.createRule(f.request("/api/routing-rules/domain?mailboxId=box","POST",ruleInput(),"owner"))).status,403);
	assert.equal(f.DB.db.prepare("SELECT mailbox_id FROM routing_rules WHERE id=?").get(id).mailbox_id,"box");
});

test("source labels survive direct central intake and still allow AI sorting before silent notification", async (t) => {
	const f = await fixture(t);
	let forwards = 0;
	for (const [recipient,label] of [["arbitrary@aperturo.test","aperturo-label"],["test@stepo-data.test","stepo-label"]]) {
		const raw = new TextEncoder().encode(`From: sender@example.test\r\nTo: ${recipient}\r\nSubject: Information\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA sample message.`).buffer;
		const result = await app.intakeIncomingMail(f.env,{from:"sender@example.test",to:recipient,raw,headers:{}},{forward:async()=>{forwards++;return true;}});
		assert.equal(result.action,"store");
		const payload = f.queued.at(-1);
		assert.equal(payload.to,recipient);
		await app.processInboundMessage(f.env,payload);
		const mail = f.DB.db.prepare("SELECT * FROM messages WHERE raw_r2_key=?").get(result.rawR2Key);
		assert.equal(mail.mailbox_id,"box");
		assert.equal(mail.user_id,"owner");
		assert.equal(mail.to_addr,recipient);
		assert.equal(mail.category,"promotions");
		assert.equal(mail.status,"received");
		assert.equal(JSON.parse(mail.sorting_decision).source,"clef");
		assert.equal(f.DB.db.prepare("SELECT folder_id FROM message_labels WHERE message_id=?").get(mail.id).folder_id,label);
		assert.equal(f.events.at(-1).silent,true);
	}
	assert.equal(f.aiCalls(),2);
	assert.equal(forwards,0);
});

test("an explicit category rule still overrides AI alongside its source label", async (t) => {
	const f = await fixture(t);
	f.DB.db.exec("UPDATE routing_rules SET category='social' WHERE id='label-aperturo'");
	const raw = new TextEncoder().encode("From: sender@example.test\r\nTo: social@aperturo.test\r\nSubject: Update\r\n\r\nA sample message.").buffer;
	f.objects.set("synthetic/explicit.eml",raw);
	await app.processInboundMessage(f.env,{from:"sender@example.test",to:"social@aperturo.test",rawR2Key:"synthetic/explicit.eml"});
	const mail = f.DB.db.prepare("SELECT * FROM messages WHERE raw_r2_key='synthetic/explicit.eml'").get();
	assert.equal(mail.category,"social");
	assert.equal(JSON.parse(mail.sorting_decision).source,"rule");
	assert.equal(f.aiCalls(),0);
	assert.equal(f.events.at(-1).silent,true);
});
