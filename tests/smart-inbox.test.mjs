import assert from "node:assert/strict";
import test, { after } from "node:test";
import { build } from "esbuild";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readdirSync,
	readFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = mkdtempSync(
	join(process.cwd(), "node_modules", "mailflare-smart-test-"),
);
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(
	join(dir, "headers.mjs"),
	"export async function cookies(){return {get:()=>undefined};}",
);
await build({
	stdin: {
		contents: `
 export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
 export {applyMigrations} from './server/runtime/migrate.ts';
 export {createSession} from './src/lib/auth/session.ts';
 export {classifyIncomingMail,resolveClefDecision} from './src/lib/mail-sorting/classifier.ts';
 export {shouldNotifyMail,isPrimaryInboxMail} from './src/lib/mail-sorting/categories.ts';
 export {getUnreadBadgeCount} from './src/lib/push/badge.ts';
 export {parseNewMessageEvent,showBrowserNewMessageNotification} from './src/hooks/message-realtime-utils.ts';
 export {DELETE as deleteLabel} from './src/app/api/folders/[folderId]/route.ts';
 export {GET as list} from './src/app/api/messages/route.ts';
 export {GET as getSenderLogo} from './src/app/api/contacts/logo/route.ts';
 export {GET as counts} from './src/app/api/messages/counts/route.ts';
 export {GET as navigation} from './src/app/api/messages/navigation/route.ts';
 export {getMessageQueryParams} from './src/hooks/utils.ts';
 export {resolveLayout} from './src/components/reorderable-list-utils.ts';
 export {GET as getOrganization,POST as organize} from './src/app/api/mail-organization/route.ts';
 export {getSortingExamples} from './src/lib/mail-sorting/learning.ts';
 export {GET as getSettings,POST as settings,DELETE as forgetSorting} from './src/app/api/settings/mail-sorting/route.ts';
 export {POST as createRule} from './src/app/api/routing-rules/route.ts';
 export {resolveInboxRuleDestination,matchesRule} from './src/lib/email/routing.ts';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';
 export {getDb} from './src/db/index.ts';
 export {resolveRoutineMail} from './src/lib/mail-sorting/routine.ts';
 export {requireSessionUser} from './src/lib/api/auth.ts';
 export {emailGet,emailSet} from './src/lib/jmap/emails.ts';
 export {mailboxGet} from './src/lib/jmap/mailboxes.ts';
 export {processInboundMessage} from './src/lib/email/inbound.ts';
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
const answers = (choice, p = 0.95, action = 0.01, security = 0.01) => ({
	category: {
		type: "choice",
		choice,
		probabilities: Object.fromEntries(
			["primary", "promotions", "social", "spam"].map((k) => [
				k,
				k === choice ? p : (1 - p) / 3,
			]),
		),
	},
	action: { type: "noul", noul: action },
	security: { type: "noul", noul: security },
});
async function fixture(t) {
	const DB = new app.SqliteDatabase(":memory:");
	t.after(() => {
		DB.db.close();
		delete globalThis.__mailflareNodeEnv;
	});
	await app.applyMigrations(DB, join(process.cwd(), "drizzle/migrations"));
	DB.db
		.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','admin',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('otherbox','other','domain','other','personal',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('work','owner','box','Work',1),('follow','owner','box','Follow up',1),('foreign','other','otherbox','Private',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,category,read,created_at) VALUES
 ('primary','owner','box','inbound','sam@example.test','owner@example.test','received','primary',0,10),
 ('promotion','owner','box','inbound','sales@example.test','owner@example.test','received','promotions',0,9),
 ('social','owner','box','inbound','linkedin@example.test','owner@example.test','received','social',0,8),
 ('spam','owner','box','inbound','scam@example.test','owner@example.test','spam','primary',0,7),
 ('foreign','other','otherbox','inbound','sam@example.test','other@example.test','received','primary',0,6);`);
	const env = {
		DB,
		MAILFLARE_RUNTIME: "node",
		AI: {
			run: async () => ({
				answers: answers("promotions"),
				usage: { input_tokens: 500 },
			}),
		},
	};
	globalThis.__mailflareNodeEnv = env;
	const tokens = {};
	for (const id of ["owner", "other"])
		tokens[id] = await app.createSession(env, id);
	const request = (path, body, user = "owner") =>
		new Request("https://mailflare.test" + path, {
			method: body ? "POST" : "GET",
			headers: {
				Authorization: "Bearer " + tokens[user],
				"Content-Type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	return {
		DB,
		env,
		request,
		db: app.getDb(env),
		input: {
			mailboxId: "box",
			userId: "owner",
			sender: "sales@example.test",
			recipient: "owner@example.test",
			subject: "Offer",
			text: "Buy now",
			spamScore: 0,
		},
	};
}
test("all incoming mail includes every category, labels, archive, snooze and trash without duplicates", async (t) => {
	const f = await fixture(t);
	f.DB.db.exec(`
		INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,category,read,created_at,folder_id,snoozed_until) VALUES
		('archived','owner','box','inbound','sam@example.test','owner@example.test','archived','primary',1,5,NULL,NULL),
		('trashed','owner','box','inbound','sam@example.test','owner@example.test','trash','primary',0,4,NULL,NULL),
		('snoozed','owner','box','inbound','sam@example.test','owner@example.test','received','primary',0,3,NULL,4102444800),
		('filed','owner','box','inbound','sam@example.test','owner@example.test','received','primary',0,2,'work',NULL),
		('sent','owner','box','outbound','owner@example.test','sam@example.test','sent','primary',0,1,NULL,NULL),
		('draft','owner','box','outbound','owner@example.test','sam@example.test','draft','primary',0,1,NULL,NULL),
		('template','owner','box','inbound','owner@example.test','sam@example.test','template','primary',0,1,NULL,NULL);
		INSERT INTO message_labels(message_id,folder_id) VALUES('primary','work'),('primary','follow');
	`);
	const expected = ['primary','promotion','social','spam','archived','trashed','snoozed','filed'];
	const params = app.getMessageQueryParams('all','box',{limit:3,offset:0});
	for (const key of ['status','category','folderId','snoozed']) assert.equal(params.has(key),false);
	const first = await (await app.list(f.request('/api/messages?' + params))).json();
	assert.equal(first.total,8);
	assert.deepEqual(first.messages.map(x=>x.id),expected.slice(0,3));
	params.set('offset','3');
	params.set('limit','100');
	const rest = await (await app.list(f.request('/api/messages?' + params))).json();
	assert.deepEqual(rest.messages.map(x=>x.id),expected.slice(3));
	const nav = await (await app.navigation(f.request('/api/messages/navigation?folder=all&mailboxId=box'))).json();
	assert.deepEqual(nav.messages.map(x=>x.id),expected);
	assert.equal(nav.messages.find(x=>x.id==='archived').unread,false);
	const counts = (await (await app.counts(f.request('/api/messages/counts?mailboxId=box'))).json()).counts;
	assert.deepEqual(counts.folders.all,{total:8,unread:7});
	assert.equal(counts.folders.inbox.unread,1);
	assert.equal(await app.getUnreadBadgeCount(f.db,{id:'owner',email:'owner@example.test',role:'user'}),1);
	const searched = app.getMessageQueryParams('all','box',{query:'from:scam@example.test',read:'unread'});
	assert.deepEqual((await (await app.list(f.request('/api/messages?' + searched))).json()).messages.map(x=>x.id),['spam']);
	// No mailbox selected still respects access; an explicit foreign mailbox is rejected.
	const unscoped = app.getMessageQueryParams('all');
	assert.deepEqual((await (await app.list(f.request('/api/messages?' + unscoped))).json()).messages.map(x=>x.id),expected);
	assert.deepEqual((await (await app.navigation(f.request('/api/messages/navigation?folder=all'))).json()).messages.map(x=>x.id),expected);
	assert.equal((await app.list(f.request('/api/messages?direction=inbound&mailboxId=otherbox'))).status,404);
	assert.equal((await app.navigation(f.request('/api/messages/navigation?folder=all&mailboxId=otherbox'))).status,404);
	assert.equal((await app.counts(f.request('/api/messages/counts?mailboxId=otherbox'))).status,404);
	assert.equal((await app.navigation(new Request('https://mailflare.test/api/messages/navigation?folder=all'))).status,401);
	// Reading a message updates the aggregate without changing membership.
	f.DB.db.exec("UPDATE messages SET read=1 WHERE id='spam'");
	assert.deepEqual((await (await app.counts(f.request('/api/messages/counts?mailboxId=box'))).json()).counts.folders.all,{total:8,unread:6});
});

test("All mail starts beneath Starred in saved layouts and preserves subsequent user placement", () => {
	const defaults = {main:['/inbox','/starred','/all','/snoozed'],more:['/spam','/trash']};
	const anchors = {'/all':'/starred'};
	assert.deepEqual(app.resolveLayout(defaults,{},anchors),defaults);
	assert.deepEqual(app.resolveLayout(defaults,{main:['/snoozed','/starred','/inbox'],more:['/trash','/spam']},anchors),{main:['/snoozed','/starred','/all','/inbox'],more:['/trash','/spam']});
	const moved = {main:['/all','/inbox','/starred','/snoozed'],more:['/spam','/trash']};
	assert.deepEqual(app.resolveLayout(defaults,moved,anchors),moved);
});

test("conservative CLEF decisions protect personal/security mail and require correlated spam", () => {
	assert.equal(
		app.resolveClefDecision(answers("promotions"), 0.9, 0).category,
		"promotions",
	);
	assert.equal(
		app.resolveClefDecision(answers("social"), 0.9, 0).category,
		"social",
	);
	for (const value of [
		answers("social", 0.99, 0.6),
		answers("promotions", 0.99, 0.01, 0.3),
		{},
	])
		assert.equal(app.resolveClefDecision(value, 0.9, 0).category, "primary");
	assert.equal(
		app.resolveClefDecision(answers("spam", 0.99), 0.9, 50).spam,
		true,
	);
	const invalid = answers("promotions");
	invalid.category.probabilities.primary = NaN;
	assert.equal(app.resolveClefDecision(invalid, 0.9, 0).source, "fallback");
});
test("AI usage is capped atomically; failure, disabled and observation modes leave mail in inbox", async (t) => {
	const f = await fixture(t);
	f.DB.db.exec(
		"INSERT INTO mailbox_sorting_settings(mailbox_id,mode,daily_limit,threshold) VALUES('box','active',1,.9)",
	);
	const result = await Promise.all([
		app.classifyIncomingMail(f.env, f.input),
		app.classifyIncomingMail(f.env, f.input),
	]);
	assert.deepEqual(result.map((x) => x.category).sort(), [
		"primary",
		"promotions",
	]);
	assert.equal(
		f.DB.db.prepare("SELECT requests FROM mail_sorting_usage").get().requests,
		1,
	);
	f.DB.db.exec(
		"UPDATE mailbox_sorting_settings SET daily_limit=10,mode='observe'",
	);
	const observed = await app.classifyIncomingMail(f.env, f.input);
	assert.equal(observed.category, "primary");
	assert.equal(observed.suggestedCategory, "promotions");
	f.DB.db.exec("UPDATE mailbox_sorting_settings SET mode='off'");
	assert.equal(
		(await app.classifyIncomingMail(f.env, f.input)).reason,
		"disabled",
	);
	f.DB.db.exec("UPDATE mailbox_sorting_settings SET mode='active'");
	f.env.AI.run = async () => {
		throw new Error("outage");
	};
	assert.equal(
		(await app.classifyIncomingMail(f.env, f.input)).category,
		"primary",
	);
});
test("conversation rows retain labels from older visible messages without duplicates or labels from hidden mailboxes", async (t) => {
	const f = await fixture(t);
	f.DB.db.exec(`
		UPDATE messages SET thread_id='shared' WHERE id IN ('primary','foreign');
		INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('hidden','owner','box','Archived only',1);
		INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,category,read,thread_id,created_at) VALUES
		('newest','owner','box','inbound','sam@example.test','owner@example.test','received','primary',1,'shared',30),
		('archived','owner','box','inbound','sam@example.test','owner@example.test','archived','primary',1,'shared',20);
		INSERT INTO message_labels(message_id,folder_id) VALUES
		('primary','work'),('primary','follow'),('newest','follow'),('archived','hidden'),('foreign','foreign'),('primary','foreign');
	`);
	const query = '/api/messages?mailboxId=box&status=received&direction=inbound';
	const grouped = await (await app.list(f.request(query+'&group=thread'))).json();
	assert.deepEqual(grouped.messages.map(message=>message.id), ['newest']);
	assert.deepEqual(grouped.messages[0].labels.map(label=>label.id).sort(), ['follow','work']);
	assert.deepEqual(grouped.messages[0].threadMessageIds.sort(), ['newest','primary']);
	const individual = await (await app.list(f.request(query))).json();
	assert.deepEqual(individual.messages.map(message=>message.id), ['newest','primary']);
	assert.deepEqual(individual.messages[0].labels.map(label=>label.id), ['follow']);
	const filtered = await (await app.list(f.request(query+'&group=thread&folderId=work'))).json();
	assert.deepEqual(filtered.messages.map(message=>message.id), ['primary']);
	assert.deepEqual(filtered.messages[0].labels.map(label=>label.id).sort(), ['follow','work']);
});

test("multiple labels share one message, remain in inbox, count once and preserve existing labels in bulk changes", async (t) => {
	const f = await fixture(t);
	assert.equal(
		(
			await app.organize(
				f.request("/api/mail-organization", {
					mailboxId: "box",
					messageIds: ["primary"],
					labelIds: ["work", "follow"],
				}),
			)
		).status,
		200,
	);
	for (const label of ["work", "follow"])
		assert.deepEqual(
			(
				await (
					await app.list(
						f.request(
							"/api/messages?mailboxId=box&folderId=" +
								label +
								"&status=received",
						),
					)
				).json()
			).messages.map((x) => x.id),
			["primary"],
		);
	const main = await (
		await app.list(
			f.request(
				"/api/messages?mailboxId=box&status=received&direction=inbound",
			),
		)
	).json();
	assert.deepEqual(
		main.messages.map((x) => x.id),
		["primary"],
	);
	assert.equal(main.messages[0].labels.length, 2);
	const result = await (
		await app.counts(f.request("/api/messages/counts?mailboxId=box"))
	).json();
	assert.equal(result.counts.folders.inbox.unread, 1);
	assert.equal(result.counts.folders.promotions.unread, 1);
	assert.equal(result.counts.folders.social.unread, 1);
	assert.equal(result.counts.customFolders.work.total, 1);
	assert.equal(result.counts.mailboxes[0].total, 4);
	await app.organize(
		f.request("/api/mail-organization", {
			mailboxId: "box",
			messageIds: ["primary", "promotion"],
			addLabelIds: ["work"],
		}),
	);
	assert.equal(
		f.DB.db
			.prepare(
				"SELECT count(*) n FROM message_labels WHERE message_id='primary'",
			)
			.get().n,
		2,
	);
	await app.organize(
		f.request("/api/mail-organization", {
			mailboxId: "box",
			messageIds: ["primary"],
			skipInbox: true,
		}),
	);
	assert.equal(
		(
			await (
				await app.list(f.request("/api/messages?mailboxId=box&status=received"))
			).json()
		).messages.length,
		0,
	);
	assert.equal(
		(
			await (
				await app.list(
					f.request(
						"/api/messages?mailboxId=box&folderId=follow&status=received",
					),
				)
			).json()
		).messages.length,
		1,
	);
});
test("authorization rejects foreign labels/messages and readonly writers without partial writes", async (t) => {
	const f = await fixture(t);
	for (const body of [
		{ messageIds: ["primary"], labelIds: ["foreign"] },
		{ messageIds: ["primary", "foreign"], labelIds: ["work"] },
	])
		assert.equal(
			(
				await app.organize(
					f.request("/api/mail-organization", { mailboxId: "box", ...body }),
				)
			).status,
			404,
		);
	assert.equal(
		f.DB.db.prepare("SELECT count(*) n FROM message_labels").get().n,
		0,
	);
	assert.equal(
		(
			await app.getOrganization(
				f.request(
					"/api/mail-organization?mailboxId=box&messageId=primary",
					undefined,
					"other",
				),
			)
		).status,
		404,
	);
	f.DB.db.exec(
		"UPDATE mailboxes SET type='shared' WHERE id='box';INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('grant','box','other','read_only',1)",
	);
	assert.equal(
		(
			await app.organize(
				f.request(
					"/api/mail-organization",
					{ mailboxId: "box", messageIds: ["primary"], category: "social" },
					"other",
				),
			)
		).status,
		404,
	);
	const csrf = new Request("https://mailflare.test/api/mail-organization", {
		method: "POST",
		headers: { Origin: "https://attacker.test" },
		body: "{}",
	});
	assert.equal((await app.organize(csrf)).status, 403);
});
test("remembered sender corrections take precedence over AI and settings are mailbox scoped", async (t) => {
	const f = await fixture(t);
	await app.organize(
		f.request("/api/mail-organization", {
			mailboxId: "box",
			messageIds: ["promotion"],
			category: "primary",
			rememberSender: true,
		}),
	);
	let calls = 0;
	f.env.AI.run = async () => {
		calls++;
		return { answers: answers("promotions") };
	};
	const result = await app.classifyIncomingMail(f.env, f.input);
	assert.equal(result.category, "primary");
	assert.equal(result.source, "override");
	assert.equal(calls, 0);
	assert.equal(
		(
			await app.getSettings(
				f.request(
					"/api/settings/mail-sorting?mailboxId=box",
					undefined,
					"other",
				),
			)
		).status,
		404,
	);
	assert.equal(
		(
			await app.settings(
				f.request("/api/settings/mail-sorting", {
					mailboxId: "box",
					mode: "active",
					dailyLimit: 10001,
					threshold: 0.9,
				}),
			)
		).status,
		400,
	);
});
test("AND/OR/exception filters assign multiple labels and skip inbox before AI", async (t) => {
	const f = await fixture(t);
	const conditions = [
		{ field: "sender", operator: "contains", value: "linkedin", negate: false },
		{ field: "title", operator: "contains", value: "security", negate: true },
	];
	const response = await app.createRule(
		f.request("/api/routing-rules", {
			mailboxId: "box",
			matchField: "sender",
			matchOperator: "contains",
			matchValue: "linkedin",
			conditions,
			conditionMode: "all",
			labelIds: ["work", "follow"],
			category: "social",
			destination: "keep",
			priority: 20,
		}),
	);
	assert.equal(response.status, 200);
	const result = await app.resolveInboxRuleDestination(f.db, {
		mailboxId: "box",
		toAddress: "owner@example.test",
		fromAddress: "digest@linkedin.test",
		subject: "Your weekly summary",
	});
	assert.equal(result.category, "social");
	assert.equal(result.labelIds.length, 2);
	assert.equal(result.matched, true);
	assert.equal(
		(
			await app.resolveInboxRuleDestination(f.db, {
				mailboxId: "box",
				toAddress: "owner@example.test",
				fromAddress: "digest@linkedin.test",
				subject: "Security alert",
			})
		).matched,
		undefined,
	);
	assert.equal(
		app.matchesRule(
			{
				pattern: "unused",
				conditions: JSON.stringify(conditions),
				conditionMode: "any",
			},
			{
				fromAddress: "sam@example.test",
				toAddress: "owner@example.test",
				subject: "Weekly",
			},
		),
		true,
	);
});
test("promotions/social/spam/archive stay silent and only primary contributes to badge", async (t) => {
	const f = await fixture(t);
	assert.equal(
		await app.getUnreadBadgeCount(f.db, {
			id: "owner",
			role: "user",
			email: "owner@example.test",
		}),
		1,
	);
	for (const category of ["promotions", "social"])
		assert.equal(app.shouldNotifyMail({ status: "received", category }), false);
	for (const status of ["spam", "trash", "archived"])
		assert.equal(app.shouldNotifyMail({ status, category: "primary" }), false);
	const event = app.parseNewMessageEvent(
		JSON.stringify({
			type: "new_message",
			silent: true,
			messageId: "promotion",
			mailboxId: "box",
			from: "sales@example.test",
		}),
	);
	assert.equal(event.silent, true);
	let notices = 0;
	globalThis.Notification = class {
		constructor() {
			notices++;
		}
		static permission = "granted";
	};
	t.after(() => delete globalThis.Notification);
	await app.showBrowserNewMessageNotification(event);
	assert.equal(notices, 0);
});
test("new backup roundtrip retains labels/settings; legacy backup rebuilds old folder membership", async (t) => {
	const f = await fixture(t);
	await app.organize(
		f.request("/api/mail-organization", {
			mailboxId: "box",
			messageIds: ["primary"],
			labelIds: ["work", "follow"],
		}),
	);
	f.DB.db.exec(
		"INSERT INTO mailbox_sorting_settings(mailbox_id,mode) VALUES('box','observe')",
	);
	const backup = await app.exportDatabaseRecords(f.env.DB);
	await app.restoreDatabaseRecords(f.env.DB, backup.buffer);
	assert.equal(
		f.DB.db.prepare("SELECT count(*) n FROM message_labels").get().n,
		2,
	);
	assert.equal(
		f.DB.db.prepare("SELECT mode FROM mailbox_sorting_settings").get().mode,
		"observe",
	);
	const legacy = JSON.parse(new TextDecoder().decode(backup));
	for (const table of [
		"message_labels",
		"mailbox_sorting_settings",
		"mail_sorting_overrides",
		"mail_sorting_usage",
	]) {
		delete legacy.tables[table];
		legacy.includedTables = legacy.includedTables.filter(
			(name) => name !== table,
		);
	}
	for (const message of legacy.tables.messages) {
		delete message.category;
		delete message.sorting_decision;
		if (message.id === "primary") message.folder_id = "work";
	}
	for (const rule of legacy.tables.routing_rules) {
		for (const field of [
			"conditions",
			"condition_mode",
			"label_ids",
			"category",
			"skip_inbox",
		])
			delete rule[field];
	}
	await app.restoreDatabaseRecords(
		f.env.DB,
		new TextEncoder().encode(JSON.stringify(legacy)).buffer,
	);
	assert.equal(
		f.DB.db.prepare("SELECT category FROM messages WHERE id='primary'").get()
			.category,
		"primary",
	);
	assert.deepEqual(
		f.DB.db
			.prepare(
				"SELECT folder_id FROM message_labels WHERE message_id='primary'",
			)
			.all(),
		[{ folder_id: "work" }],
	);
});

test("JMAP reads and writes multiple labels and exposes promotions/social as separate mailboxes", async (t) => {
	const f = await fixture(t);
	await app.organize(
		f.request("/api/mail-organization", {
			mailboxId: "box",
			messageIds: ["primary"],
			labelIds: ["work", "follow"],
		}),
	);
	const { user } = await app.requireSessionUser(
		f.env,
		f.request("/api/messages"),
	);
	const ctx = {
		env: f.env,
		db: f.db,
		auth: { user, userId: "owner", mailboxIds: null },
		accountId: "owner",
		origin: "https://mailflare.test",
		createdIds: {},
	};
	const emails = await app.emailGet(ctx, { ids: ["primary", "promotion"] });
	assert.deepEqual(
		Object.keys(emails.list[0].mailboxIds).sort(),
		["box~f~follow", "box~f~work", "box~inbox"].sort(),
	);
	assert.equal(emails.list[1].mailboxIds["box~c~promotions"], true);
	const mailboxes = await app.mailboxGet(ctx, {});
	assert.equal(
		mailboxes.list.find((row) => row.id === "box~c~promotions").totalEmails,
		1,
	);
	assert.equal(
		mailboxes.list.find((row) => row.id === "box~f~follow").totalEmails,
		1,
	);
	const changed = await app.emailSet(ctx, {
		update: {
			primary: {
				mailboxIds: {
					"box~f~work": true,
					"box~f~follow": true,
					"box~c~social": true,
				},
			},
		},
	});
	assert.equal(changed.updated.primary, null);
	assert.equal(
		f.DB.db.prepare("SELECT category FROM messages WHERE id='primary'").get()
			.category,
		"social",
	);
	const denied = await app.emailSet(ctx, {
		update: { primary: { mailboxIds: { "box~f~foreign": true } } },
	});
	assert.equal(denied.notUpdated.primary.type, "invalidProperties");
	assert.equal(
		f.DB.db
			.prepare(
				"SELECT count(*) n FROM message_labels WHERE message_id='primary'",
			)
			.get().n,
		2,
	);
});
test("inbound mail is classified before realtime delivery; spam and social refresh silently", async (t) => {
	const f = await fixture(t);
	f.DB.db.exec("UPDATE users SET spam_protection_enabled=0 WHERE id='owner'");
	const events = [];
	let aiCalls = 0;
	f.env.REALTIME = {
		getByName: () => ({
			fetch: async (_url, init) => {
				events.push(JSON.parse(init.body));
				return new Response();
			},
		}),
	};
	f.env.AI.run = async () => {
		aiCalls++;
		return { answers: answers("social") };
	};
	f.env.BUCKET = {
		get: async () => ({
			arrayBuffer: async () =>
				new TextEncoder().encode(
					"From: updates@linkedin.test\r\nTo: owner@example.test\r\nSubject: Network digest\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour network updates.",
				).buffer,
		}),
	};
	await app.processInboundMessage(f.env, {
		from: "updates@linkedin.test",
		to: "owner@example.test",
		rawR2Key: "synthetic/social.eml",
	});
	const mail = f.DB.db
		.prepare(
			"SELECT id,category,status FROM messages WHERE raw_r2_key='synthetic/social.eml'",
		)
		.get();
	assert.equal(mail.category, "social");
	assert.equal(events.at(-1).silent, true);
	assert.equal(events.at(-1).messageId, mail.id);
	assert.equal(aiCalls, 1);
	await app.processInboundMessage(f.env, {
		from: "updates@linkedin.test",
		to: "owner@example.test",
		rawR2Key: "synthetic/social.eml",
	});
	assert.equal(aiCalls, 1);
	assert.equal(events.length, 1);
});
test("backup works before smart inbox migration and its older document restores after upgrading", async (t) => {
	const migrationDir = join(dir, "pre-smart");
	mkdirSync(migrationDir);
	for (const name of readdirSync("drizzle/migrations").filter(
		(name) => name.endsWith(".sql") && !["0061_smart_inbox.sql", "0062_mail_sorting_feedback.sql"].includes(name),
	))
		writeFileSync(
			join(migrationDir, name),
			readFileSync(join("drizzle/migrations", name)),
		);
	const DB = new app.SqliteDatabase(":memory:");
	t.after(() => DB.db.close());
	await app.applyMigrations(DB, migrationDir);
	const backup = await app.exportDatabaseRecords(DB);
	await app.restoreDatabaseRecords(DB, backup.buffer);
	await app.applyMigrations(DB, join(process.cwd(), "drizzle/migrations"));
	await app.restoreDatabaseRecords(DB, backup.buffer);
	assert.equal(
		DB.db.prepare("SELECT count(*) n FROM message_labels").get().n,
		0,
	);
});

test("bulk shortcuts spare AI calls while excluding security, personal messages and transactions", async (t) => {
	const f = await fixture(t);
	let calls = 0;
	f.env.AI.run = async () => {
		calls++;
		return { answers: answers("social") };
	};
	const input = {
		...f.input,
		headers: { "List-Unsubscribe": "<https://example.test/unsubscribe>" },
		subject: "Nur heute: 40% Rabatt",
		text: "Jetzt kaufen und sparen",
	};
	assert.equal(
		(await app.classifyIncomingMail(f.env, input)).category,
		"promotions",
	);
	assert.equal(calls, 0);
	assert.equal(
		app.resolveRoutineMail({
			...input,
			subject: "Dein Netzwerk auf LinkedIn wächst",
			sender: "digest@linkedin.com",
		}).category,
		"social",
	);
	for (const subject of [
		"Security alert: your network",
		"Neue Anmeldung: 40% Rabatt",
		"Nachricht von Anna",
		"Rechnung: 40% Rabatt",
	])
		assert.equal(
			app.resolveRoutineMail({
				...input,
				subject,
				sender: "digest@linkedin.com",
			}),
			null,
		);
	assert.equal(app.resolveRoutineMail({ ...input, headers: {} }), null);
});

 test('primary membership counts read mail correctly and ignores snoozed mail',()=>{
  const message={status:'received',direction:'inbound',category:'primary',read:true};assert.equal(app.isPrimaryInboxMail(message),true);assert.equal(app.shouldNotifyMail(message),false);assert.equal(app.isPrimaryInboxMail({...message,category:'social'}),false);assert.equal(app.isPrimaryInboxMail({...message,snoozedUntil:new Date(Date.now()+3600000).toISOString()}),false);
 });


test("deleting a label preserves mail, attachments, other labels and filter actions", async t => {
 const f = await fixture(t);
 f.DB.db.exec(`
  UPDATE messages SET folder_id='work' WHERE id='primary';
  INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES ('primary','work'),('primary','follow'),('spam','work'),('foreign','foreign');
  INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES ('attachment','primary','contract.pdf','application/pdf',100,'private-key',1);
  INSERT INTO routing_rules(id,user_id,domain_id,mailbox_id,scope,pattern,match_value,label_ids,folder_id,category,skip_inbox,created_at) VALUES
   ('filter','owner','domain','box','mailbox','sam','sam','["work","follow"]','work','social',1,1),
   ('foreign-filter','other','domain','otherbox','mailbox','sam','sam','["foreign"]','foreign','promotions',0,1);
 `);
 const context={params:Promise.resolve({folderId:'work'})};
 const response=await app.deleteLabel(new Request(f.request('/api/folders/work?mailboxId=box'),{method:'DELETE'}),context);
 assert.equal(response.status,200);
 assert.equal(f.DB.db.prepare('SELECT count(*) AS n FROM messages').get().n,5);
 assert.equal(f.DB.db.prepare('SELECT r2_key FROM message_attachments').get().r2_key,'private-key');
 assert.deepEqual(f.DB.db.prepare("SELECT folder_id,status,category FROM messages WHERE id='primary'").get(),{folder_id:null,status:'archived',category:'primary'});
 assert.deepEqual(f.DB.db.prepare("SELECT status,category FROM messages WHERE id='spam'").get(),{status:'spam',category:'primary'});
 assert.deepEqual(f.DB.db.prepare("SELECT folder_id FROM message_labels WHERE message_id='primary'").all(),[{folder_id:'follow'}]);
 assert.equal(f.DB.db.prepare("SELECT count(*) AS n FROM folders WHERE id='work'").get().n,0);
 assert.deepEqual(f.DB.db.prepare("SELECT label_ids,folder_id,category,skip_inbox FROM routing_rules WHERE id='filter'").get(),{label_ids:'["follow"]',folder_id:null,category:'social',skip_inbox:1});
 assert.deepEqual(f.DB.db.prepare("SELECT label_ids,folder_id FROM routing_rules WHERE id='foreign-filter'").get(),{label_ids:'["foreign"]',folder_id:'foreign'});
 const all=await (await app.list(f.request('/api/messages?direction=inbound&mailboxId=box'))).json();
 assert.equal(all.total,4);
 assert.equal((await app.deleteLabel(new Request(f.request('/api/folders/work?mailboxId=box'),{method:'DELETE'}),context)).status,404);
});

test("label deletion rejects unauthenticated, foreign, mismatched and read-only access", async t => {
 const f=await fixture(t),context={params:Promise.resolve({folderId:'work'})};
 assert.equal((await app.deleteLabel(new Request('https://mailflare.test/api/folders/work?mailboxId=box',{method:'DELETE'}),context)).status,401);
 assert.equal((await app.deleteLabel(new Request(f.request('/api/folders/work?mailboxId=box',undefined,'other'),{method:'DELETE'}),context)).status,404);
 assert.equal((await app.deleteLabel(new Request(f.request('/api/folders/work?mailboxId=otherbox'),{method:'DELETE'}),context)).status,404);
 assert.equal((await app.deleteLabel(new Request(f.request('/api/folders/work'),{method:'DELETE'}),context)).status,400);
 f.DB.db.exec(`UPDATE mailboxes SET type='shared' WHERE id='box'; INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('grant','box','other','read_only',1);`);
 assert.equal((await app.deleteLabel(new Request(f.request('/api/folders/work?mailboxId=box',undefined,'other'),{method:'DELETE'}),context)).status,404);
 assert.equal(f.DB.db.prepare("SELECT count(*) AS n FROM folders WHERE id='work'").get().n,1);
});


test('two-stage decisions route known non-inbox mail despite split category probabilities',()=>{
 const replay=(probabilities,inbox=.01)=>({category:{type:'choice',choice:Object.entries(probabilities).sort((a,b)=>b[1]-a[1])[0][0],probabilities},inbox:{type:'noul',noul:inbox},action:{type:'noul',noul:.01},security:{type:'noul',noul:.01}});
 const uber=replay({primary:.0226,promotions:.4114,social:.0197,spam:.5463});
 assert.equal(app.resolveClefDecision(uber,.8,0).category,'promotions');assert.equal(app.resolveClefDecision(uber,.8,0).reviewRequired,true);
 const linkedin=replay({primary:.019,promotions:.1252,social:.8036,spam:.0522});assert.equal(app.resolveClefDecision(linkedin,.8,0).category,'social');
 const split=replay({primary:.05,promotions:.4,social:.45,spam:.1},.2);assert.equal(app.resolveClefDecision(split,.8,0).category,'social');
 assert.equal(app.resolveClefDecision({...split,inbox:{type:'noul',noul:.21}},.8,0).category,'primary');
 assert.equal(app.resolveClefDecision({...split,inbox:{type:'noul',noul:.15}},.9,0).category,'primary');
 assert.equal(app.resolveClefDecision(answers('spam',.95),.8,50).spam,true);
 assert.equal(app.resolveClefDecision(answers('spam',.99),.8,0).category,'promotions');
 for(const field of ['action','security'])assert.equal(app.resolveClefDecision({...uber,[field]:{type:'noul',noul:field==='action'?.6:.3}},.8,50).category,'primary');
 for(const noul of [NaN,1.1,-.1])assert.equal(app.resolveClefDecision({...uber,inbox:{type:'noul',noul}},.8,0).reason,'invalid_model_response');
});

test('first-order vouchers and LinkedIn job alerts route correctly without capturing receipts or lookalike domains',async t=>{
 const f=await fixture(t);let calls=0;f.env.AI.run=async()=>{calls++;return {answers:answers('primary')};};
 const input={...f.input,sender:'"Uber" <uber@uber.com>',subject:'Nicht mehr lange: Spare € 15 bei deinen ersten 2 Bestellungen',text:'Spare bei deinen ersten Bestellungen. Jetzt bestellen!',headers:{'List-Unsubscribe':'<https://uber.com/unsubscribe>'}};
 assert.equal((await app.classifyIncomingMail(f.env,input)).category,'promotions');
 assert.equal((await app.classifyIncomingMail(f.env,{...input,sender:'jobalerts-noreply@linkedin.com',subject:'Regional VP of Sales, DACH and CEE regions at monday.com',headers:{}})).category,'social');assert.equal(calls,0);
 for(const subject of ['Dein Uber Beleg','Your Uber receipt','Uber Rechnung','Your order confirmation','Bestelldaten: Deine Bestellung','Deine Zahlungsbestätigung','Security alert','Re: Spare €15']){
  const result=await app.classifyIncomingMail(f.env,{...input,subject});assert.equal(result.category,'primary',subject);
 }
 assert.equal((await app.classifyIncomingMail(f.env,{...input,subject:'Deine Fahrt',text:'Rechnungsnummer 2026-123. Gesamtbetrag €15.'})).category,'primary');
 assert.equal(app.resolveRoutineMail({...input,sender:'jobalerts-noreply@linkedin.com.attacker.test',subject:'VP of Sales',headers:{}}),null);
 assert.equal(app.resolveRoutineMail({...input,sender:'anna@linkedin.com',subject:'Nachricht von Anna'}),null);
});

test('confirmed category corrections persist independently, stay mailbox scoped and reach subsequent AI requests',async t=>{
 const f=await fixture(t);f.DB.db.exec(`UPDATE messages SET from_addr='"Uber" <uber@uber.com>',subject='Spare €15 bei deinen ersten Bestellungen' WHERE id='primary'`);
 const correction=await app.organize(f.request('/api/mail-organization',{mailboxId:'box',messageIds:['primary'],category:'promotions'}));assert.equal(correction.status,200);
 assert.deepEqual(await app.getSortingExamples(f.env,'box'),[{sender:'uber@uber.com',subject:'Spare €15 bei deinen ersten Bestellungen',category:'promotions'}]);
 assert.deepEqual(await app.getSortingExamples(f.env,'otherbox'),[]);
 let request;f.env.AI.run=async(model,input)=>{request=input;return {answers:answers('promotions')};};
 assert.equal((await app.classifyIncomingMail(f.env,{...f.input,sender:'uber@uber.com',subject:'Dein nächstes Angebot'})).learningExamples,1);
 assert.deepEqual(request.state.userCorrections,await app.getSortingExamples(f.env,'box'));assert.equal(request.questions.inbox.type,'noul');
 await app.organize(f.request('/api/mail-organization',{mailboxId:'box',messageIds:['primary'],category:'primary'}));assert.equal((await app.getSortingExamples(f.env,'box'))[0].category,'primary');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mail_sorting_feedback').get().n,1);
 await app.organize(f.request('/api/mail-organization',{mailboxId:'box',messageIds:['social'],skipInbox:true}));assert.equal(f.DB.db.prepare('SELECT count(*) n FROM mail_sorting_feedback').get().n,1);
 const backup=await app.exportDatabaseRecords(f.DB);await app.restoreDatabaseRecords(f.DB,backup.buffer);assert.equal((await app.getSortingExamples(f.env,'box')).length,1);
 f.DB.db.exec("DELETE FROM messages WHERE id='primary'");assert.equal((await app.getSortingExamples(f.env,'box')).length,1);assert.equal(f.DB.db.prepare('SELECT message_id FROM mail_sorting_feedback').get().message_id,null);
 assert.equal((await app.forgetSorting(new Request(f.request('/api/settings/mail-sorting',{mailboxId:'box',clearLearning:true},'other'),{method:'DELETE'}))).status,404);
 assert.equal((await app.forgetSorting(new Request(f.request('/api/settings/mail-sorting',{mailboxId:'box',clearLearning:true}),{method:'DELETE'}))).status,200);assert.deepEqual(await app.getSortingExamples(f.env,'box'),[]);
});

test('remembered bulk senders cannot override transactions, security or personal conversations',async t=>{
 const f=await fixture(t);f.DB.db.exec(`INSERT INTO mail_sorting_overrides(mailbox_id,sender,category) VALUES ('box','uber@uber.com','promotions')`);
 for(const subject of ['Your Uber receipt','Dein Beleg','Bestelldaten','Order confirmation','Login alert','Nachricht von Anna']){
  assert.equal((await app.classifyIncomingMail(f.env,{...f.input,sender:'uber@uber.com',subject})).category,'primary',subject);
 }
 assert.equal((await app.classifyIncomingMail(f.env,{...f.input,sender:'uber@uber.com',subject:'Gutschein'})).category,'promotions');
});

test('German account security events survive wrong CLEF spam answers, sender learning and unavailable AI', async t => {
 const f = await fixture(t);
 f.DB.db.exec("INSERT INTO mail_sorting_overrides(mailbox_id,sender,category) VALUES ('box','no-reply@accounts.google.com','promotions')");
 let calls = 0;
 f.env.AI.run = async () => { calls++; return { answers: answers('spam', .8914, .0614, .0581) }; };
 const input = { ...f.input, sender: '"Google" <no-reply@accounts.google.com>', headers: {
  'Authentication-Results': 'mx.cloudflare.net; dmarc=pass header.from=accounts.google.com; dkim=pass',
  'List-Unsubscribe': '<https://accounts.google.com/preferences>',
 }, text: 'Neue Anmeldung auf einem Apple iPhone. Prüfe die Aktivität in deinem Google-Konto.' };
 for (const subject of ['Sicherheitswarnung', 'Sicherheitswarnung für owner@example.test', 'SICHERHEITSWARNUNG',
  'Sicherheitsmeldung', 'Anmeldebenachrichtigung', 'Passwortänderung', 'Passwort zurücksetzen',
  'Verdächtige Aktivität', 'Security alert', 'New sign-in', 'Password changed']) {
  const result = await app.classifyIncomingMail(f.env, { ...input, subject });
  assert.equal(result.category, 'primary', subject);
  assert.equal(result.reason, 'protected_account_security', subject);
  assert.equal(result.policyVersion, 3);
  assert.equal(app.resolveRoutineMail({ ...input, subject }), null);
 }
 assert.equal(calls, 0);
 delete f.env.AI;
 assert.equal((await app.classifyIncomingMail(f.env, { ...input, subject: 'Sicherheitswarnung' })).category, 'primary');
 f.DB.db.exec("INSERT INTO mailbox_sorting_settings(mailbox_id,mode,daily_limit,threshold) VALUES ('box','observe',0,.8)");
 assert.equal((await app.classifyIncomingMail(f.env, { ...input, subject: 'Sicherheitswarnung' })).reason, 'observation');
 f.DB.db.exec("UPDATE mailbox_sorting_settings SET mode='off'");
 assert.equal((await app.classifyIncomingMail(f.env, { ...input, subject: 'Sicherheitswarnung' })).reason, 'disabled');
});

test('security wording does not bypass spam evidence or protect security product marketing', async t => {
 const f = await fixture(t);
 let calls = 0, request;
 f.env.AI.run = async (_model, input) => { calls++; request = input; return { answers: answers('spam', .99) }; };
 const suspicious = { ...f.input, sender: '"Google" <no-reply@accounts.google.com>', subject: 'Sicherheitswarnung', spamScore: 60,
  headers: { 'Authentication-Results': 'mx.cloudflare.net; dmarc=fail; dkim=fail; spf=fail' } };
 assert.equal((await app.classifyIncomingMail(f.env, suspicious)).spam, true);
 assert.deepEqual(request.state.authentication, ['dmarc_failed', 'dkim_failed', 'spf_failed']);
 assert.equal(request.state.spamScore, 60);
 // Failures from the receiver prevent the subject shortcut even below the spam threshold.
 assert.notEqual((await app.classifyIncomingMail(f.env, { ...suspicious, spamScore: 20 })).reason, 'protected_account_security');
 assert.equal(calls, 2);
 // Sender-injected Authentication-Results from another server are excluded from AI evidence.
 await app.classifyIncomingMail(f.env, { ...suspicious, headers: { 'Authentication-Results': 'attacker.test; dmarc=pass; dkim=pass' } });
 assert.deepEqual(request.state.authentication, []);
 f.env.AI.run = async () => ({ answers: answers('promotions') });
 for (const subject of ['Sicherheitstipps: unser Newsletter', 'Security software sale', 'Passwortmanager: 40% Rabatt']) {
  const result = await app.classifyIncomingMail(f.env, { ...f.input, subject, text: 'Jetzt kaufen und sparen' });
  assert.equal(result.category, 'promotions', subject);
 }
});

test('authenticated Google security alerts are stored in primary and delivered with normal notifications', async t => {
 const f = await fixture(t), events = [];
 let calls = 0;
 f.env.AI.run = async () => { calls++; return { answers: answers('spam', .8914, .0614, .0581) }; };
 f.env.REALTIME = { getByName: () => ({ fetch: async (_url, init) => { events.push(JSON.parse(init.body)); return new Response(); } }) };
 f.env.BUCKET = { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode(
  'From: Google <no-reply@accounts.google.com>\r\nTo: owner@example.test\r\nSubject: Sicherheitswarnung\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNeue Anmeldung auf einem Apple iPhone.').buffer }) };
 await app.processInboundMessage(f.env, { from: 'no-reply@accounts.google.com', to: 'owner@example.test',
  rawR2Key: 'synthetic/security.eml', headers: { 'Authentication-Results': 'mx.cloudflare.net; dmarc=pass; dkim=pass' } });
 const row = f.DB.db.prepare("SELECT category,status,sorting_decision FROM messages WHERE raw_r2_key='synthetic/security.eml'").get();
 assert.equal(row.category, 'primary'); assert.equal(row.status, 'received');
 assert.equal(JSON.parse(row.sorting_decision).reason, 'protected_account_security');
 assert.equal(calls, 0); assert.equal(events.length, 1); assert.equal(events[0].silent, false);
});

test('AI failures quarantine non-personal list mail in Promotions while off and observe stay respected',async t=>{
 const f=await fixture(t),input={...f.input,headers:{'List-Unsubscribe':'<https://example.test/unsub>'},subject:'Weekly newsletter'};
 delete f.env.AI;const result=await app.classifyIncomingMail(f.env,input);assert.equal(result.category,'promotions');assert.equal(result.fallbackReason,'unavailable');assert.equal(app.shouldNotifyMail({status:'received',category:result.category}),false);
 assert.equal((await app.classifyIncomingMail(f.env,{...input,subject:'Your receipt'})).category,'primary');
 f.DB.db.exec("INSERT INTO mailbox_sorting_settings(mailbox_id,mode,daily_limit,threshold) VALUES('box','observe',0,.8)");assert.equal((await app.classifyIncomingMail(f.env,input)).category,'primary');
 f.DB.db.exec("UPDATE mailbox_sorting_settings SET mode='off'");assert.equal((await app.classifyIncomingMail(f.env,input)).category,'primary');
 f.DB.db.exec("UPDATE mailbox_sorting_settings SET mode='active'");f.env.AI={run:async()=>({answers:{}})};assert.equal((await app.classifyIncomingMail(f.env,input)).fallbackReason,'daily_limit');
 f.DB.db.exec("UPDATE mailbox_sorting_settings SET daily_limit=1000");assert.equal((await app.classifyIncomingMail(f.env,input)).fallbackReason,'invalid_model_response');
 f.env.AI.run=async()=>{throw new Error('outage');};assert.equal((await app.classifyIncomingMail(f.env,input)).fallbackReason,'ai_error');
});

test('80-percent default is visible and configurable without accepting unsafe thresholds',async t=>{
 const f=await fixture(t);assert.equal((await (await app.getSettings(f.request('/api/settings/mail-sorting?mailboxId=box'))).json()).settings.threshold,.8);
 for(const threshold of [.8,.85,.9])assert.equal((await app.settings(f.request('/api/settings/mail-sorting',{mailboxId:'box',mode:'active',dailyLimit:1000,threshold}))).status,200);
 assert.equal((await app.settings(f.request('/api/settings/mail-sorting',{mailboxId:'box',mode:'active',dailyLimit:1000,threshold:.79}))).status,400);
});

test('inbox contact photo metadata uses the message owner and never exposes storage keys', async t=>{
 const f=await fixture(t);
 f.DB.db.exec("INSERT INTO contacts(id,user_id,email,display_name,avatar_key,created_at) VALUES('photo','owner','sam@example.test','Sam','private-owner-photo',1),('foreign-photo','other','sales@example.test','Sales','private-other-photo',1)");
 const response=await app.list(f.request('/api/messages?mailboxId=box&direction=inbound'));const text=await response.text();const rows=JSON.parse(text).messages;
 assert.equal(rows.find(x=>x.id==='primary').fromContactHasAvatar,true);assert.equal(rows.find(x=>x.id==='promotion').fromContactHasAvatar,false);
 assert(!text.includes('private-owner-photo'));assert(!text.includes('private-other-photo'));
});


test("sender logos require login, mailbox access and an existing owner's contact", async (t) => {
 const f = await fixture(t);
 let reads=0,fetches=0;
 f.env.BUCKET={get:async()=>{reads++;return null;},put:async()=>{}};
 const previous=globalThis.fetch;
 globalThis.fetch=async()=>{fetches++;return new Response(null,{status:404});};
 t.after(()=>globalThis.fetch=previous);
 const path='/api/contacts/logo?mailboxId=box&address=sender%40company.com';
 assert.equal((await app.getSenderLogo(new Request('https://mailflare.test'+path))).status,401);
 f.DB.db.exec("INSERT INTO contacts(id,user_id,email,source,created_at) VALUES('logo-owner','owner','sender@company.com','inbound',1),('logo-other','other','private@company.com','inbound',1)");
 assert.equal((await app.getSenderLogo(f.request(path,undefined,'other'))).status,404);
 assert.equal((await app.getSenderLogo(f.request('/api/contacts/logo?mailboxId=box&address=private%40company.com'))).status,404);
 assert.equal((await app.getSenderLogo(f.request('/api/contacts/logo?mailboxId=box&address=x%40127.0.0.1'))).status,404);
 assert.equal(reads,0);assert.equal(fetches,0);
 assert.equal((await app.getSenderLogo(f.request(path))).status,404);
 assert.equal(fetches,1);assert.equal(reads,2);
 f.DB.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='box'");
 assert.equal((await app.getSenderLogo(f.request(path))).status,404);assert.equal(fetches,1);
});
