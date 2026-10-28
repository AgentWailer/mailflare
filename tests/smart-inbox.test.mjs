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
 export {createSession,getUserFromSession,deleteSession} from './src/lib/auth/session.ts';
 export {getCurrentUser} from './src/lib/auth/cookies.ts';
 export {listAccessibleMailboxes} from './src/lib/mailboxes/access.ts';
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
 export {runEmailTool} from './src/lib/agent/tools.ts';
 export {resolveRoutineMail} from './src/lib/mail-sorting/routine.ts';
 export {requireSessionUser} from './src/lib/api/auth.ts';
 export {emailQuery} from './src/lib/jmap/emails.ts';
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
	assert.equal(counts.folders.inbox.unread,2);
	assert.equal(await app.getUnreadBadgeCount(f.db,{id:'owner',email:'owner@example.test',role:'user'}),2);
	const searched = app.getMessageQueryParams('all','box',{query:'from:scam@example.test',read:'unread'});
	assert.deepEqual((await (await app.list(f.request('/api/messages?' + searched))).json()).messages.map(x=>x.id),[]);
	const withSpam = app.getMessageQueryParams('all','box',{query:'from:scam@example.test in:anywhere',read:'unread'});
	assert.deepEqual((await (await app.list(f.request('/api/messages?' + withSpam))).json()).messages.map(x=>x.id),['spam']);
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
	assert.deepEqual(grouped.messages.map(message=>message.id), ['newest','social']);
	assert.deepEqual(grouped.messages[0].labels.map(label=>label.id).sort(), ['follow','work']);
	assert.deepEqual(grouped.messages[0].threadMessageIds.sort(), ['newest','primary']);
	const individual = await (await app.list(f.request(query))).json();
	assert.deepEqual(individual.messages.map(message=>message.id), ['newest','primary','social']);
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
		["primary", "social"],
	);
	assert.equal(main.messages[0].labels.length, 2);
	const result = await (
		await app.counts(f.request("/api/messages/counts?mailboxId=box"))
	).json();
	assert.equal(result.counts.folders.inbox.unread, 2);
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
		1,
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
test("promotions/social/spam/archive stay silent and badge matches visible inbox", async (t) => {
	const f = await fixture(t);
	assert.equal(
		await app.getUnreadBadgeCount(f.db, {
			id: "owner",
			role: "user",
			email: "owner@example.test",
		}),
		2,
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
		(name) => name.endsWith(".sql") && name < "0061_",
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
  const message={status:'received',direction:'inbound',category:'primary',read:true};assert.equal(app.isPrimaryInboxMail(message),true);assert.equal(app.shouldNotifyMail(message),false);assert.equal(app.isPrimaryInboxMail({...message,category:'social'}),true);assert.equal(app.isPrimaryInboxMail({...message,snoozedUntil:new Date(Date.now()+3600000).toISOString()}),false);
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


test('uncertain destination or uncorrelated spam remains visible in primary',()=>{
 const replay=(probabilities,inbox=.01)=>({category:{type:'choice',choice:Object.entries(probabilities).sort((a,b)=>b[1]-a[1])[0][0],probabilities},inbox:{type:'noul',noul:inbox},action:{type:'noul',noul:.01},security:{type:'noul',noul:.01}});
 const uber=replay({primary:.0226,promotions:.4114,social:.0197,spam:.5463});
 assert.equal(app.resolveClefDecision(uber,.8,0).category,'primary');assert.equal(app.resolveClefDecision(uber,.8,0).reviewRequired,true);
 const linkedin=replay({primary:.019,promotions:.1252,social:.8036,spam:.0522});assert.equal(app.resolveClefDecision(linkedin,.8,0).category,'social');
 const split=replay({primary:.05,promotions:.4,social:.45,spam:.1},.2);assert.equal(app.resolveClefDecision(split,.8,0).category,'primary');
 assert.equal(app.resolveClefDecision({...split,inbox:{type:'noul',noul:.21}},.8,0).category,'primary');
 assert.equal(app.resolveClefDecision({...split,inbox:{type:'noul',noul:.15}},.9,0).category,'primary');
 assert.equal(app.resolveClefDecision(answers('spam',.95),.8,50).spam,true);
 assert.equal(app.resolveClefDecision(answers('spam',.99),.8,0).category,'primary');
 for(const field of ['action','security'])assert.equal(app.resolveClefDecision({...uber,[field]:{type:'noul',noul:field==='action'?.6:.3}},.8,50).category,'primary');
 for(const noul of [NaN,1.1,-.1])assert.equal(app.resolveClefDecision({...uber,inbox:{type:'noul',noul}},.8,0).reason,'invalid_model_response');
});

test('first-order vouchers and LinkedIn job alerts route correctly without capturing receipts or lookalike domains',async t=>{
 const f=await fixture(t);let calls=0;f.env.AI.run=async()=>{calls++;return {answers:answers('primary')};};
 const input={...f.input,sender:'"Uber" <uber@uber.com>',subject:'Nicht mehr lange: Spare € 15 bei deinen ersten 2 Bestellungen',text:'Spare bei deinen ersten Bestellungen. Jetzt bestellen!',headers:{'List-Unsubscribe':'<https://uber.com/unsubscribe>'}};
 assert.equal((await app.classifyIncomingMail(f.env,input)).category,'promotions');
 assert.equal((await app.classifyIncomingMail(f.env,{...input,sender:'jobalerts-noreply@linkedin.com',subject:'Regional VP of Sales, DACH and CEE regions at monday.com',headers:{}})).category,'social');assert.equal(calls,0);
 for(const subject of ['Dein Uber Beleg','Your Uber receipt','Uber Rechnung','Your order confirmation','Bestelldaten: Deine Bestellung','Deine Zahlungsbestätigung','Security alert','Re: Spare €15']){
  const result=await app.classifyIncomingMail(f.env,{...input,subject});assert.equal(result.category,/receipt|Beleg|Rechnung|Zahlungsbestätigung/i.test(subject)?'invoices':/order confirmation|Bestelldaten|Bestellung/i.test(subject)?'orders':'primary',subject);
 }
 assert.equal((await app.classifyIncomingMail(f.env,{...input,subject:'Deine Fahrt',text:'Rechnungsnummer 2026-123. Gesamtbetrag €15.'})).category,'invoices');
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
  assert.equal((await app.classifyIncomingMail(f.env,{...f.input,sender:'uber@uber.com',subject})).category,/receipt|Beleg/i.test(subject)?'invoices':/Order confirmation|Bestelldaten/i.test(subject)?'orders':'primary',subject);
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
  assert.equal(result.policyVersion, 7);
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

test('AI failure and quota exhaustion keep list mail visible while off and observe stay respected',async t=>{
 const f=await fixture(t),input={...f.input,headers:{'List-Unsubscribe':'<https://example.test/unsub>'},subject:'Weekly newsletter'};
 delete f.env.AI;const result=await app.classifyIncomingMail(f.env,input);assert.equal(result.category,'primary');assert.equal(result.reviewRequired,true);assert.equal(result.fallbackReason,'unavailable');assert.equal(app.shouldNotifyMail({status:'received',category:result.category}),true);
 assert.equal((await app.classifyIncomingMail(f.env,{...input,subject:'Your receipt'})).category,'invoices');
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

test('five-category sorting separates real receipts/orders from coupons and protects security with zero AI charges', async t => {
 const f=await fixture(t);let calls=0;f.env.AI.run=async()=>{calls++;return {answers:answers('promotions')};};
 for(const [subject,category] of [['Ihre Rechnung 2026-123','invoices'],['Zahlungsbeleg #123','invoices'],['Quittung für deine Fahrt','invoices'],['Your payment confirmation','invoices'],['Gutschrift zur Bestellung','invoices'],['Bestellung 123 ist eingegangen','orders'],['Versandbestätigung','orders'],['Order confirmation #123','orders'],['Sicherheitswarnung von Google','primary']]){
  const result=await app.classifyIncomingMail(f.env,{...f.input,subject});assert.equal(result.category,category,subject);assert.equal(result.policyVersion,7);assert.equal(result.source,'rule');
 }
 assert.equal(calls,0);
 const coupon=await app.classifyIncomingMail(f.env,{...f.input,subject:'Rechnung erstellen: 40% Rabatt',text:'Spare jetzt beim Kauf',headers:{'List-Unsubscribe':'<https://example.test>'}});assert.equal(coupon.category,'promotions');
 const result=await app.classifyIncomingMail(f.env,{...f.input,subject:'Bestellung jetzt mit Gutschein',text:'Kaufe mit Rabatt',headers:{'List-Unsubscribe':'<https://example.test>'}});assert.equal(result.category,'promotions');
});

test('CLEF receives six choices and financial uncertainty cannot become advertising', async t => {
 const f=await fixture(t);let request;
 const choice=category=>({inbox:{type:'noul',noul:.01},category:{type:'choice',choice:category,probabilities:Object.fromEntries(['primary','invoices','orders','promotions','social','spam'].map(k=>[k,k===category?.95:.01]))},action:{type:'noul',noul:.01},security:{type:'noul',noul:.01}});
 f.env.AI.run=async(_model,input)=>{request=input;return {answers:choice('invoices')}};
 const result=await app.classifyIncomingMail(f.env,{...f.input,subject:'Dokument zur vergangenen Fahrt',text:'Vielen Dank. Hier ist dein Dokument.'});assert.equal(result.category,'invoices');assert.deepEqual(Object.keys(request.questions.category.criteria).sort(),['primary','invoices','orders','promotions','social','spam'].sort());
 const uncertain=choice('invoices');uncertain.category.probabilities={primary:.05,invoices:.4,orders:.1,promotions:.4,social:.03,spam:.02};assert.equal(app.resolveClefDecision(uncertain,.8,0).category,'primary');assert.equal(app.resolveClefDecision(uncertain,.8,0).reviewRequired,true);
 const security=choice('invoices');security.security.noul=.9;assert.equal(app.resolveClefDecision(security,.8,0).category,'primary');
 const invalid=choice('orders');invalid.category.probabilities.orders=NaN;assert.equal(app.resolveClefDecision(invalid,.8,0).source,'fallback');
});

test('invoice/order lists, counters and navigation exclude archive while preserving labels and access isolation', async t => {
 const f=await fixture(t);f.DB.db.exec("UPDATE messages SET category='invoices' WHERE id='primary';UPDATE messages SET category='orders',status='archived' WHERE id='promotion';INSERT INTO message_labels(message_id,folder_id) VALUES('primary','work');UPDATE messages SET category='invoices' WHERE id='foreign'");
 const {user}=await app.requireSessionUser(f.env,f.request('/api/messages'));
 for(const [category,ids] of [['invoices',['primary']],['orders',[]]]){
  const list=await(await app.list(f.request('/api/messages?mailboxId=box&status=received&category='+category))).json();assert.deepEqual(list.messages.map(x=>x.id),ids);
  const nav=await(await app.navigation(f.request('/api/messages/navigation?mailboxId=box&folder='+category))).json();assert.deepEqual(nav.messages.map(x=>x.id),ids);
  const assistant=await app.runEmailTool({env:f.env,user,mailboxId:'box',origin:'chat'},'list_emails',{folder:category,limit:20});assert.deepEqual(assistant.emails.map(x=>x.id),ids);
  const params=app.getMessageQueryParams(category,'box');assert.equal(params.get('category'),category);assert.equal(params.get('status'),'received');
 }
 const counts=await(await app.counts(f.request('/api/messages/counts?mailboxId=box'))).json();assert.equal(counts.counts.folders.invoices.total,1);assert.equal(counts.counts.folders.orders.total,0);assert.equal(counts.counts.folders.archived.total,1);assert.equal(counts.counts.folders.inbox.total,2);assert.equal(counts.counts.customFolders.work.total,1);
 assert.equal((await app.list(f.request('/api/messages?mailboxId=otherbox&status=received&category=invoices'))).status,404);
});

test('JMAP hides archived receipts from categories while preserving archive and label-only edits', async t => {
 const f=await fixture(t);f.DB.db.exec("UPDATE messages SET category='invoices',status='archived' WHERE id='primary';UPDATE messages SET category='orders' WHERE id='promotion'");
 const {user}=await app.requireSessionUser(f.env,f.request('/api/messages'));const ctx={env:f.env,db:f.db,auth:{user,userId:'owner',mailboxIds:null},accountId:'owner',origin:'https://mailflare.test',createdIds:{}};
 const emails=await app.emailGet(ctx,{ids:['primary','promotion']});assert.equal(emails.list[0].mailboxIds['box~c~invoices'],undefined);assert.equal(emails.list[0].mailboxIds['box~archive'],true);assert.equal(emails.list[1].mailboxIds['box~c~orders'],true);
 const boxes=await app.mailboxGet(ctx,{});assert.equal(boxes.list.find(x=>x.id==='box~c~invoices').totalEmails,0);assert.equal(boxes.list.find(x=>x.id==='box~c~orders').totalEmails,1);
 const queried=await app.emailQuery(ctx,{filter:{inMailbox:'box~c~invoices'}});assert.deepEqual(queried.ids,[]);
 const changed=await app.emailSet(ctx,{update:{primary:{'mailboxIds/box~f~work':true}}});assert.equal(changed.updated.primary,null);assert.equal(f.DB.db.prepare("SELECT status FROM messages WHERE id='primary'").get().status,'archived');assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='primary'").get().category,'invoices');
});

test('confirmed older sender examples are retrieved beyond recent bulk corrections and remain mailbox scoped', async t => {
 const f=await fixture(t);const insert=f.DB.db.prepare('INSERT INTO mail_sorting_feedback(id,mailbox_id,sender,subject,category,corrected_at) VALUES(?,?,?,?,?,?)');
 insert.run('old','box','uber@uber.com','Quittung zu deiner Fahrt','invoices','2020-01-01');insert.run('foreign-old','otherbox','uber@uber.com','Quittung zu deiner Fahrt','promotions','2026-12-01');
 for(let i=0;i<100;i++)insert.run('new-'+i,'box','newsletter'+i+'@example.test','Neuigkeiten '+i,'promotions','2026-01-01');
 const examples=await app.getSortingExamples(f.env,'box',{sender:'Uber <uber@uber.com>',subject:'Quittung zu deiner Fahrt'});assert.equal(examples[0].category,'invoices');assert.equal(examples[0].sender,'uber@uber.com');assert(examples.length<=6);assert(!examples.some(x=>x.sender==='uber@uber.com'&&x.category==='promotions'));
 const settings=await(await app.getSettings(f.request('/api/settings/mail-sorting?mailboxId=box'))).json();assert.equal(settings.learningExamples,101);assert.equal(settings.learningSummary.find(x=>x.category==='invoices').count,1);
 const response=await app.organize(f.request('/api/mail-organization',{mailboxId:'box',messageIds:['primary'],category:'orders'}));assert.equal(response.status,200);assert.equal(f.DB.db.prepare("SELECT category FROM mail_sorting_feedback WHERE message_id='primary'").get().category,'orders');
});

test('new invoice/order alerts retain transaction relevance while advertising and historical archive remain silent',async t=>{
 const f=await fixture(t);const message={status:'received',direction:'inbound',folderId:null,read:false};
 for(const category of ['primary','invoices','orders']){assert.equal(app.shouldNotifyMail({...message,category}),true);assert.equal(app.shouldNotifyMail({...message,category,status:'archived'}),false);assert.equal(app.shouldNotifyMail({...message,category,read:true}),false);assert.equal(app.shouldNotifyMail({...message,category,snoozedUntil:new Date(Date.now()+3600000)}),false);}
 for(const category of ['promotions','social'])assert.equal(app.shouldNotifyMail({...message,category}),false);
 f.DB.db.exec("UPDATE messages SET category='invoices' WHERE id='primary';UPDATE messages SET category='orders' WHERE id='promotion'");const {user}=await app.requireSessionUser(f.env,f.request('/api/messages'));assert.equal(await app.getUnreadBadgeCount(f.db,user),3);f.DB.db.exec("UPDATE messages SET status='archived' WHERE id='primary'");assert.equal(await app.getUnreadBadgeCount(f.db,user),2);
});

test('Freenet invoices, orders and social remain in inbox as well as their categories across list/counts/badge/JMAP',async t=>{
 const f=await fixture(t);
 f.DB.db.exec(`UPDATE messages SET category='invoices',from_addr='freenet <noreply@freenet-mobilfunk.de>',subject='Neue freenet Rechnung M26067823747' WHERE id='primary';
 UPDATE messages SET category='orders' WHERE id='promotion';
 INSERT INTO message_labels(message_id,folder_id) VALUES ('primary','work');
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,category,read,created_at,snoozed_until) VALUES
 ('advertising','owner','box','inbound','sales@example.test','owner@example.test','Sale','received','promotions',0,5,NULL),
 ('archived-invoice','owner','box','inbound','billing@example.test','owner@example.test','Invoice','archived','invoices',0,4,NULL),
 ('snoozed-invoice','owner','box','inbound','billing@example.test','owner@example.test','Invoice','received','invoices',0,3,4102444800);`);
 const inbox=await(await app.list(f.request('/api/messages?mailboxId=box&direction=inbound&status=received'))).json();assert.deepEqual(inbox.messages.map(x=>x.id),['primary','promotion','social']);
 const invoices=await(await app.list(f.request('/api/messages?mailboxId=box&direction=inbound&status=received&category=invoices'))).json();assert.deepEqual(invoices.messages.map(x=>x.id),['primary']);
 const nav=await(await app.navigation(f.request('/api/messages/navigation?mailboxId=box&folder=inbox'))).json();assert.deepEqual(nav.messages.map(x=>x.id),['primary','promotion','social']);
 const counts=(await(await app.counts(f.request('/api/messages/counts?mailboxId=box'))).json()).counts;assert.deepEqual(counts.folders.inbox,{total:3,unread:3});assert.equal(counts.folders.invoices.total,1);assert.equal(counts.folders.orders.total,1);assert.equal(counts.mailboxes[0].inbox,3);
 const {user}=await app.requireSessionUser(f.env,f.request('/api/messages'));assert.equal(await app.getUnreadBadgeCount(f.db,user),3);
 const ctx={env:f.env,db:f.db,auth:{user,userId:'owner',mailboxIds:null},accountId:'owner',origin:'https://mailflare.test',createdIds:{}};
 const email=(await app.emailGet(ctx,{ids:['primary']})).list[0];assert.equal(email.mailboxIds['box~inbox'],true);assert.equal(email.mailboxIds['box~c~invoices'],true);assert.equal(email.mailboxIds['box~f~work'],true);
 const boxes=await app.mailboxGet(ctx,{});assert.equal(boxes.list.find(x=>x.id==='box~inbox').totalEmails,3);assert.equal(boxes.list.find(x=>x.id==='box~inbox').unreadEmails,3);
 const queried=await app.emailQuery(ctx,{filter:{inMailbox:'box~inbox'}});assert.deepEqual(queried.ids,['primary','promotion','social']);
 const edited=await app.emailSet(ctx,{update:{primary:{'mailboxIds/box~f~follow':true}}});assert.equal(edited.updated.primary,null);assert.equal(f.DB.db.prepare("SELECT category FROM messages WHERE id='primary'").get().category,'invoices');assert.equal(f.DB.db.prepare("SELECT status FROM messages WHERE id='primary'").get().status,'received');
});

test('large imported mail keeps exact startup counts and selects metadata through covering indexes', async t => {
 const f = await fixture(t);
 const insert = f.DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,category,read,created_at,text_body,html_body) VALUES(?,'owner','box','inbound','sender@example.test','owner@example.test','received','invoices',0,?, ?, ?)");
 const body = 'Long imported MIME content '.repeat(600);
 f.DB.db.transaction(() => { for(let i=0;i<3000;i++){ insert.run('import-'+i,100+i,body,body); f.DB.db.prepare("INSERT INTO message_labels(message_id,folder_id) VALUES(?,'work')").run('import-'+i); } })();
 const plans = [], prepare = f.DB.prepare.bind(f.DB);
 f.DB.prepare = query => {
  const statement=prepare(query), bind=statement.bind.bind(statement);
  statement.bind=(...params)=>{
   if(query.startsWith('select') && query.includes('messages')) plans.push({query, details:f.DB.db.prepare('EXPLAIN QUERY PLAN '+query).all(...params).map(row=>row.detail)});
   return bind(...params);
  };return statement;
 };
 const result=await (await app.counts(f.request('/api/messages/counts?mailboxId=box'))).json();
 assert.equal(result.counts.folders.inbox.unread,3002);assert.equal(result.counts.folders.invoices.unread,3000);assert.equal(result.counts.customFolders.work.unread,3000);
 const countsPlan=plans.find(plan=>plan.query.includes('group by') && !plan.query.includes('message_labels'));
 assert(countsPlan.details.some(detail=>/COVERING INDEX messages_counts_cover_idx/.test(detail)),JSON.stringify(countsPlan));
 assert(!countsPlan.details.some(detail=>/TEMP B-TREE FOR GROUP BY/.test(detail)),JSON.stringify(countsPlan));
 const labelsPlan=plans.find(plan=>plan.query.includes('message_labels') && plan.query.includes('sum('));
 assert(labelsPlan.details.some(detail=>/COVERING INDEX messages_(?:counts|page|category_page|conversation)_cover_idx/.test(detail)),JSON.stringify(labelsPlan));
 plans.length=0;
 const list=await (await app.list(f.request('/api/messages?mailboxId=box&direction=inbound&status=received&category=primary&limit=25'))).json();assert.equal(list.total,3002);assert.equal(list.messages.length,25);
 const totalPlan=plans.find(plan=>plan.query.includes('count(*)'));
 assert(totalPlan.details.some(detail=>/COVERING INDEX messages_/.test(detail)),JSON.stringify(totalPlan));
 assert(list.messages.every(message=>message.textBody===undefined&&message.htmlBody===undefined));
});

test('optimized message-list authorization still checks current valid shared-mailbox read grants', async t => {
 const f=await fixture(t);f.DB.db.exec("UPDATE mailboxes SET type='shared' WHERE id='otherbox';INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('shared-grant','owner','otherbox','read_only',1)");
 const read=await app.list(f.request('/api/messages?mailboxId=otherbox'));assert.equal(read.status,200);assert.equal((await read.json()).messages[0].id,'foreign');
 f.DB.db.exec("UPDATE mailbox_access SET permission='invalid-legacy-value' WHERE id='shared-grant'");assert.equal((await app.list(f.request('/api/messages?mailboxId=otherbox'))).status,404);
 f.DB.db.exec("DELETE FROM mailbox_access WHERE id='shared-grant'");assert.equal((await app.list(f.request('/api/messages?mailboxId=otherbox'))).status,404);
});


test('first category conversation pages use body-free metadata indexes for counts, heads and matching members', async t=>{
 const f=await fixture(t);
 const insert=f.DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,category,read,thread_id,created_at,text_body,html_body) VALUES(?,'owner','box','inbound','sender@example.test','owner@example.test',?,?,0,?,?,?,?)");
 const body='Long unrelated imported MIME content '.repeat(500);
 f.DB.db.transaction(()=>{
  for(let i=0;i<3000;i++)insert.run('noise-'+i,'archived','primary','noise-thread-'+i,i,body,body);
  for(const category of ['promotions','social','invoices','orders'])for(let i=0;i<60;i++){const id=category+'-'+i;insert.run(id,i%2?'archived':'received',category,category+'-thread-'+Math.floor(i/2),10000+i,body,body);f.DB.db.prepare("INSERT INTO message_labels(message_id,folder_id) VALUES(?,'work')").run(id);}
 })();
 const plans=[],prepare=f.DB.prepare.bind(f.DB);f.DB.prepare=query=>{const statement=prepare(query),bind=statement.bind.bind(statement);statement.bind=(...params)=>{if(query.startsWith('select')&&query.includes('messages'))plans.push({query,details:f.DB.db.prepare('EXPLAIN QUERY PLAN '+query).all(...params).map(row=>row.detail)});return bind(...params);};return statement;};
 for(const category of ['promotions','social','invoices','orders']){
  plans.length=0;const page=await (await app.list(f.request('/api/messages?mailboxId=box&direction=inbound&status=received&category='+category+'&limit=25&group=thread'))).json();
  const systemExtra=category==='promotions'||category==='social'?1:0;assert.equal(page.total,30+systemExtra);assert.equal(page.messages.length,25);assert(page.messages.every(message=>message.category===category));
  for(const queryPart of ['count(distinct','row_number()','"id", coalesce']){
   const plan=plans.find(plan=>plan.query.includes(queryPart));assert(plan,'expected page-query plan '+queryPart);
   assert(plan.details.some(detail=>/COVERING INDEX messages_(conversation|category_page)_cover_idx/.test(detail)),JSON.stringify({category,plan}));
  }
  assert(page.messages.every(message=>message.labels.some(label=>label.id==='work')));
  assert(page.messages.every(message=>message.threadMessageIds.length===1));
 }
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('messages_mailbox_thread_key_idx','messages_thread_key_idx')").get().n,0);
});


test('one session lookup preserves user preferences and immediately respects expiry, revocation and account disabling', async t => {
 const f = await fixture(t);
 const token = await app.createSession(f.env, 'owner');
 f.DB.db.exec("UPDATE users SET time_zone='Europe/Berlin',label_order='{\"box\":[\"work\"]}',allow_external_content=0 WHERE id='owner'");
 const sql=[];const prepare=f.DB.prepare.bind(f.DB);t.mock.method(f.DB,'prepare',query=>{sql.push(query);return prepare(query);});
 assert.equal(await app.getUserFromSession(f.env,undefined),null);assert.equal(sql.length,0);
 const user=await app.getUserFromSession(f.env,token);assert.equal(sql.length,1);
 assert.equal(user.id,'owner');assert.equal(user.timeZone,'Europe/Berlin');assert.equal(user.allowExternalContent,false);assert.equal(user.labelOrder,'{"box":["work"]}');assert(user.createdAt instanceof Date);
 f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
 const request=new Request('https://mailflare.test',{headers:{Authorization:'Bearer '+token}});
 assert.equal(await app.getCurrentUser(f.env,request),null);
 f.DB.db.exec("UPDATE users SET disabled=0 WHERE id='owner';UPDATE sessions SET expires_at=0 WHERE user_id='owner'");
 assert.equal(await app.getUserFromSession(f.env,token),null);
 const fresh=await app.createSession(f.env,'owner');await app.deleteSession(f.env,fresh);assert.equal(await app.getUserFromSession(f.env,fresh),null);
 assert.equal(await app.getUserFromSession(f.env,'unknown-token'),null);
});

test('batched mailbox discovery preserves identity and current delegated permissions', async t => {
 const f=await fixture(t);
 f.DB.db.exec("UPDATE mailboxes SET avatar_key='avatars/owner',signature='Regards' WHERE id='box';UPDATE mailboxes SET type='shared' WHERE id='otherbox';INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('grant','otherbox','owner','read_only',1)");
 let calls=0;const batch=f.DB.batch.bind(f.DB);t.mock.method(f.DB,'batch',queries=>{calls++;return batch(queries);});
 const user={id:'owner',email:'owner@example.test',role:'user'};
 const boxes=await app.listAccessibleMailboxes(f.db,user);assert.equal(calls,1);
 assert.deepEqual(boxes.map(x=>[x.id,x.permission,x.isPrimary,x.hasAvatar]),[['box','full_access',true,true],['otherbox','read_only',false,false]]);
 assert.equal(boxes[0].signature,'Regards');assert.equal('avatarKey' in boxes[0],false);
 f.DB.db.exec("DELETE FROM mailbox_access WHERE id='grant'");assert.deepEqual((await app.listAccessibleMailboxes(f.db,user)).map(x=>x.id),['box']);
 f.DB.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='box'");assert.deepEqual(await app.listAccessibleMailboxes(f.db,user),[]);
});

test('ungrouped pages batch count and rows without losing exact pagination or labels', async t => {
 const f=await fixture(t);
 f.DB.db.exec("INSERT INTO message_labels(message_id,folder_id) VALUES('social','work')");
 const batches=[];const batch=f.DB.batch.bind(f.DB);t.mock.method(f.DB,'batch',queries=>{batches.push(queries.length);return batch(queries);});
 const res=await app.list(f.request('/api/messages?mailboxId=box&direction=inbound&limit=1&offset=2'));assert.equal(res.status,200);
 const page=await res.json();assert.equal(page.total,4);assert.equal(page.messages[0].id,'social');assert.equal(page.messages[0].labels[0].name,'Work');assert.equal('htmlBody' in page.messages[0],false);assert.equal('textBody' in page.messages[0],false);
 assert.deepEqual(batches,[2,2],'mailbox access and count/page each take one batch');
});


test('poor legacy previews are repaired from bounded visible bodies once without exposing mail bodies or touching foreign mail',async t=>{
 const f=await fixture(t);
 f.DB.db.exec("UPDATE messages SET snippet='https://tracking.test/click?id=123',text_body='Please use an email client supporting HTML email, or click this link to view the email online: https://tracking.test/click',html_body='<p>Ihre Rechnung über 49,90 Euro ist verfügbar.</p>' WHERE id='primary';UPDATE messages SET snippet='https://foreign.test/private' WHERE id='foreign'");
 const result=await (await app.list(f.request('/api/messages?mailboxId=box&direction=inbound'))).json();const row=result.messages.find(x=>x.id==='primary');
 assert.equal(row.snippet,'Ihre Rechnung über 49,90 Euro ist verfügbar.');assert.equal('textBody' in row,false);assert.equal('htmlBody' in row,false);
 assert.equal(f.DB.db.prepare("SELECT snippet FROM messages WHERE id='primary'").get().snippet,row.snippet);assert.equal(f.DB.db.prepare("SELECT snippet FROM messages WHERE id='foreign'").get().snippet,'https://foreign.test/private');
 const sql=[];const prepare=f.DB.prepare.bind(f.DB);t.mock.method(f.DB,'prepare',query=>{sql.push(query);return prepare(query);});await app.list(f.request('/api/messages?mailboxId=box&direction=inbound'));assert(!sql.some(query=>query.includes('substr(')),'subsequent normal list loads use only cached metadata');
});
test('list attachment counts exclude inline/trash files and stay scoped to matching conversation members',async t=>{
 const f=await fixture(t);
 f.DB.db.exec(`
 UPDATE messages SET thread_id='thread' WHERE id IN ('primary','promotion','foreign','spam');
 INSERT INTO message_labels(message_id,folder_id) VALUES('primary','work'),('promotion','work'),('social','work');
 INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,r2_key,created_at,trashed_at) VALUES
 ('pdf','primary','invoice.pdf','application/pdf',100,'attachment','pdf',1,NULL),
 ('logo','primary','logo.png','image/png',20,'inline','logo',1,NULL),
 ('deleted','primary','deleted.pdf','application/pdf',20,'attachment','deleted',1,1),
 ('older-pdf','promotion','old.pdf','application/pdf',20,'attachment','old',1,NULL),
 ('foreign-file','foreign','private.pdf','application/pdf',20,'attachment','foreign',1,NULL),
 ('spam-file','spam','spam.pdf','application/pdf',20,'attachment','spam',1,NULL);`);
 const list=async query=>(await (await app.list(f.request('/api/messages?mailboxId=box&direction=inbound&'+query))).json()).messages;
 const single=await list('status=received&folderId=work');assert.equal(single.find(m=>m.id==='primary').attachmentCount,1);assert.equal(single.find(m=>m.id==='promotion').attachmentCount,1);assert.equal(single.find(m=>m.id==='social').attachmentCount,0);
 const grouped=await list('status=received&folderId=work&group=thread');assert.equal(grouped.find(m=>m.id==='primary').attachmentCount,2);
 const inbox=await list('status=received&category=primary&group=thread');assert.equal(inbox.find(m=>m.id==='primary').attachmentCount,1);
 // A newer message without a file still represents the older member's attachment.
 f.DB.db.exec("DELETE FROM message_attachments WHERE id='pdf'");const older=await list('status=received&folderId=work&group=thread');assert.equal(older.find(m=>m.id==='primary').attachmentCount,1);
 assert(single.every(m=>!('attachments' in m)&&!('textBody' in m)&&!('htmlBody' in m)));
});

test('a real low-advertising / uncorrelated-spam decision is never converted to Promotions',()=>{
 const probabilities={invoices:.0243,orders:.0319,primary:.0827,promotions:.0347,social:.0336,spam:.7928};
 const decision=app.resolveClefDecision({category:{type:'choice',choice:'spam',probabilities},inbox:{type:'noul',noul:.063},action:{type:'noul',noul:.0264},security:{type:'noul',noul:.0515}},.8,0);
 assert.equal(decision.category,'primary');assert.equal(decision.reason,'spam_uncertain');assert.equal(decision.reviewRequired,true);assert.notEqual(decision.spam,true);
 for(const probability of [.4,.6,.8,.89])assert.equal(app.resolveClefDecision(answers('promotions',probability),.8,0).category,'primary');
 assert.equal(app.resolveClefDecision(answers('promotions',.95),.8,0).category,'promotions');
});

test('collection correspondence, objections and deadlines stay visible despite bulk headers, sender overrides and wrong AI guesses',async t=>{
 const f=await fixture(t);let calls=0;f.env.AI.run=async()=>{calls++;return {answers:answers('spam',.99)};};
 f.DB.db.exec("INSERT INTO mail_sorting_overrides(mailbox_id,sender,category) VALUES('box','case@example.test','promotions')");
 const base={...f.input,sender:'case@example.test',text:'Vielen Dank für Ihre E-Mail. Wir prüfen Ihren Widerspruch zum Aktenzeichen TEST-123.',headers:{'List-Unsubscribe':'<https://example.test/unsub>'}};
 for(const subject of ['Ihre Email bzgl. Widerspruch wegen Verdachts auf Identitätsmissbrauch – Aktenzeichen TEST-123','Unser Aktenzeichen: TEST-456 / Forderung der Firma Beispiel','Letzte Mahnung','Zahlungsaufforderung','Mahnbescheid','Notice of default']){
  const result=await app.classifyIncomingMail(f.env,{...base,subject});assert.equal(result.category,'primary',subject);assert.equal(result.reason,'protected_legal_or_payment_demand');assert.equal(result.policyVersion,7);
 }
 assert.equal(calls,0,'important cases do not need another AI call');
 f.DB.db.exec("DELETE FROM mail_sorting_overrides WHERE sender='case@example.test'");
 const bodyCase=await app.classifyIncomingMail(f.env,{...base,subject:'Bitte beachten',text:'Inkasso: Unser Aktenzeichen TEST-789. Bitte zahlen Sie die offene Forderung bis zum Ende der Frist.'});assert.equal(bodyCase.reason,'protected_legal_or_payment_demand');
 delete f.env.AI;assert.equal((await app.classifyIncomingMail(f.env,base)).category,'primary');
});

test('marketing about collection services is not protected and clear spam evidence still wins',async t=>{
 const f=await fixture(t);
 for(const subject of ['Newsletter: Tipps für Ihr Inkasso','Webinar: Mahnungen schreiben','Inkassosoftware für Unternehmen']){
  assert.equal((await app.classifyIncomingMail(f.env,{...f.input,subject,text:'Lernen Sie unser Angebot kennen. Jetzt buchen!'})).category,'promotions');
 }
 f.env.AI.run=async()=>({answers:answers('spam',.99)});
 const result=await app.classifyIncomingMail(f.env,{...f.input,subject:'Zahlungsaufforderung',text:'Aktenzeichen TEST-123',spamScore:60,headers:{'Authentication-Results':'mx.cloudflare.net; dmarc=fail; dkim=fail'}});
 assert.equal(result.spam,true);assert.notEqual(result.reason,'protected_legal_or_payment_demand');
});

test('new collection mail is persisted in primary and generates an ordinary inbox notification',async t=>{
 const f=await fixture(t);let calls=0;const events=[];
 f.env.AI.run=async()=>{calls++;return {answers:answers('spam',.99)};};
 f.env.REALTIME={getByName:()=>({fetch:async(_url,init)=>{events.push(JSON.parse(init.body));return new Response(null,{status:204});}})};
 f.env.BUCKET={get:async()=>({arrayBuffer:async()=>new TextEncoder().encode('From: Case team <case@example.test>\r\nTo: owner@example.test\r\nSubject: Widerspruch - Aktenzeichen TEST-123\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nVielen Dank fuer Ihre E-Mail. Wir pruefen Ihren Widerspruch.').buffer})};
 await app.processInboundMessage(f.env,{from:'case@example.test',to:'owner@example.test',rawR2Key:'synthetic/collection.eml',headers:{'Authentication-Results':'mx.cloudflare.net; dmarc=pass; dkim=pass'}});
 const row=f.DB.db.prepare("SELECT category,status,sorting_decision FROM messages WHERE raw_r2_key='synthetic/collection.eml'").get();
 assert.equal(row.category,'primary');assert.equal(row.status,'received');assert.equal(JSON.parse(row.sorting_decision).reason,'protected_legal_or_payment_demand');assert.equal(calls,0);assert.equal(events.length,1);assert.equal(events[0].silent,false);
});

test('System One sorting uses the matching Omni selector, records the model and spends one quota reservation',async t=>{
 const f=await fixture(t);const calls=[];
 f.env.AI.run=async(model,request)=>{calls.push({model,request});return {model:'clef-omni',answers:answers('promotions'),usage:{input_tokens:1234}};};
 const result=await app.classifyIncomingMail(f.env,f.input);
 assert.equal(calls.length,1);assert.equal(calls[0].model,'@cf/cloudflare/clef-omni');assert.equal(calls[0].request.model,'clef-omni');
 assert.equal(calls[0].request.questions.category.type,'choice');for(const key of ['inbox','action','security'])assert.equal(calls[0].request.questions[key].type,'noul');
 assert.equal(result.category,'promotions');assert.equal(result.model,'@cf/cloudflare/clef-omni');assert.equal(result.policyVersion,7);
 assert.deepEqual(f.DB.db.prepare('SELECT requests,input_tokens FROM mail_sorting_usage').get(),{requests:1,input_tokens:1234});
 const settings=await(await app.getSettings(f.request('/api/settings/mail-sorting?mailboxId=box'))).json();assert.equal(settings.model,'@cf/cloudflare/clef-omni');
});

test('a mismatched returned decision model is treated as unavailable instead of acting on its classification',async t=>{
 const f=await fixture(t);f.env.AI.run=async()=>({model:'unexpected-model',answers:answers('promotions')});
 const result=await app.classifyIncomingMail(f.env,f.input);assert.equal(result.category,'primary');assert.equal(result.reason,'invalid_model_response');assert.equal(result.reviewRequired,true);assert.equal(result.model,'@cf/cloudflare/clef-omni');
});
