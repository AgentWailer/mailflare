// Moving recipients between To, Cc and Bcc, and the ranked suggestions offered while typing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-recipient-workflow-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/components/compose/recipient-utils.ts";
			export * from "./src/components/compose/recipient-suggest-utils.ts";
			export * from "./src/lib/contacts/recipient-directory-utils.ts";
			export { formatEmailAddress, parseEmailAddressParts, splitEmailAddressList } from "./src/lib/email/address.ts";
		`,
		resolveDir: root,
		sourcefile: "recipient-workflow-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const lines = () => ({
	to: ['"Maya Chen" <maya@example.com>', "dev@example.com"],
	cc: ["lin@harbor.example"],
	bcc: [],
});

test("a recipient moves from To to Cc and keeps its display name", () => {
	const next = app.moveRecipient(lines(), '"Maya Chen" <maya@example.com>', "to", "cc");
	assert.deepEqual(next, { to: ["dev@example.com"], cc: ["lin@harbor.example", '"Maya Chen" <maya@example.com>'], bcc: [] });
});

test("a recipient can be dropped at a chosen place of another line", () => {
	const next = app.moveRecipient(lines(), "dev@example.com", "to", "cc", 0);
	assert.deepEqual(next.cc, ["dev@example.com", "lin@harbor.example"]);
	assert.deepEqual(next.to, ['"Maya Chen" <maya@example.com>']);
});

test("moving into a line that already holds the address never duplicates it", () => {
	const start = { to: ["Lin <lin@harbor.example>", "dev@example.com"], cc: ["lin@harbor.example"], bcc: [] };
	const next = app.moveRecipient(start, "Lin <lin@harbor.example>", "to", "cc");
	assert.deepEqual(next, { to: ["dev@example.com"], cc: ["lin@harbor.example"], bcc: [] });
});

test("dragging within one line reorders it, and dropping a chip where it was changes nothing", () => {
	const start = { to: ["a@example.com", "b@example.com", "c@example.com"], cc: [], bcc: [] };
	assert.deepEqual(app.moveRecipient(start, "a@example.com", "to", "to", 3).to, ["b@example.com", "c@example.com", "a@example.com"]);
	assert.deepEqual(app.moveRecipient(start, "c@example.com", "to", "to", 0).to, ["c@example.com", "a@example.com", "b@example.com"]);
	assert.deepEqual(app.moveRecipient(start, "a@example.com", "to", "to", 2).to, ["b@example.com", "a@example.com", "c@example.com"]);
	// Before itself and before its right neighbour are both "where it was".
	assert.equal(app.moveRecipient(start, "b@example.com", "to", "to", 1), start);
	assert.equal(app.moveRecipient(start, "b@example.com", "to", "to", 2), start);
	assert.equal(app.moveRecipient(start, "missing@example.com", "to", "cc"), start);
});

test("a move never loses or invents a recipient, whatever the indexes", () => {
	const fields = ["to", "cc", "bcc"];
	let seed = 20261126;
	const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
	let state = { to: ["a@x.test", "b@x.test", "c@x.test"], cc: ["d@x.test"], bcc: ["e@x.test", "f@x.test"] };
	for (let step = 0; step < 2000; step++) {
		const from = fields[random(3)], to = fields[random(3)];
		const entry = state[from][random(Math.max(1, state[from].length))] ?? "nobody@x.test";
		state = app.moveRecipient(state, entry, from, to, random(3) === 0 ? undefined : random(8) - 1);
		const all = [...state.to, ...state.cc, ...state.bcc];
		assert.deepEqual([...all].sort(), ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test", "f@x.test"], `step ${step}`);
	}
});

test("outsiders named by a warning move to Bcc from both visible lines", () => {
	const start = { to: ["me@lumen.example", "Ann <ann@one.example>"], cc: ["bob@two.example", "colleague@lumen.example"], bcc: ["old@three.example"] };
	const next = app.moveRecipientsToBcc(start, ["ANN@one.example", "bob@two.example"]);
	assert.deepEqual(next, { to: ["me@lumen.example"], cc: ["colleague@lumen.example"], bcc: ["old@three.example", "Ann <ann@one.example>", "bob@two.example"] });
});

test("a display name with quotes, commas and backslashes survives formatting, joining and splitting", () => {
	for (const name of ['Chen, Maya', 'Maya "MC" Chen', "Back\\slash", 'a"b,c;d', "Jürgen Müller-Lüdenscheidt"]) {
		const formatted = app.formatEmailAddress("maya@example.com", name);
		const list = app.recipientsToHeader([formatted, "dev@example.com"]);
		const entries = app.splitEmailAddressList(list);
		assert.equal(entries.length, 2, list);
		assert.deepEqual(app.parseEmailAddressParts(entries[0]), { name, address: "maya@example.com" });
		assert.deepEqual(app.headerToRecipients(list), [formatted, "dev@example.com"]);
	}
});

const day = 86_400_000, now = Date.UTC(2026, 10, 26);
const contact = (email, displayName, source, lastSeenAt, blocked = false) => ({ email, displayName, source, blocked, lastSeenAt: new Date(lastSeenAt) });
const sentTo = (toAddr, at, ccAddr = null, bccAddr = null) => ({ toAddr, ccAddr, bccAddr, createdAt: new Date(at) });

test("suggestions rank people written to most, then most recently, before people only seen in incoming mail", () => {
	const list = app.buildRecipientDirectory({
		now,
		own: ["Owner@Lumen.example"],
		contacts: [
			contact("newsletter@shop.example", "Shop News", "inbound", now - day),
			contact("maya@example.com", "Maya Chen", "outbound", now - 40 * day),
			contact("spammer@bad.example", "Nice Offer", "inbound", now, true),
			contact("owner@lumen.example", "Me", "manual", now),
			contact("address-book@example.com", "Address Book Only", "manual", now - 300 * day),
		],
		sent: [
			sentTo('"Maya C." <maya@example.com>', now - 40 * day),
			sentTo("maya@example.com, Dev Patel <dev@example.com>", now - 30 * day),
			sentTo("dev@example.com", now - 2 * day, "maya@example.com", "Hidden <hidden@example.com>"),
			sentTo("dev@example.com", now - day),
			sentTo("spammer@bad.example, owner@lumen.example", now - day),
		],
	});
	assert.deepEqual(list.map((entry) => entry.email), ["dev@example.com", "maya@example.com", "hidden@example.com", "address-book@example.com", "newsletter@shop.example"]);
	const [dev, maya, hidden] = list;
	assert.deepEqual([dev.sends, maya.sends, hidden.sends], [3, 3, 1]);
	assert.equal(dev.name, "Dev Patel", "a name used in sent mail fills in for an address without a contact name");
	assert.equal(maya.name, "Maya Chen", "the contact's own name wins over the name typed in sent mail");
	assert.equal(dev.lastSentAt, now - day);
	assert(!list.some((entry) => entry.email === "spammer@bad.example"), "blocked contacts are never suggested, even when mail went to them");
	assert(!list.some((entry) => entry.email === "owner@lumen.example"), "the owner's own addresses are left out");
});

test("one message counts once per address, and a date in the future counts as now", () => {
	const list = app.buildRecipientDirectory({
		now, own: [], contacts: [],
		sent: [sentTo("twice@example.com, Twice <TWICE@example.com>", now + 900 * day, "twice@example.com"), sentTo("other@example.com", now - day), sentTo("other@example.com", now - 2 * day)],
	});
	assert.deepEqual(list.map((entry) => [entry.email, entry.sends, entry.lastSentAt]), [["other@example.com", 2, now - day], ["twice@example.com", 1, now]]);
});

test("the directory is cut to its limit after ranking and survives malformed rows", () => {
	const sent = Array.from({ length: 300 }, (_, index) => sentTo(`person${index}@example.com`, now - index * day));
	sent.push(sentTo("favourite@example.com", now - 500 * day), sentTo("favourite@example.com", now - 501 * day));
	sent.push({ toAddr: null, ccAddr: "", bccAddr: "not an address, <>, @", createdAt: null }, sentTo(",,;;", Number.NaN));
	const list = app.buildRecipientDirectory({ now, own: [], sent, contacts: [contact("no-at-sign", "Broken", "manual", now), contact("  Mixed@Case.example ", null, "manual", null)], limit: 25 });
	assert.equal(list.length, 25);
	assert.equal(list[0].email, "favourite@example.com", "the most written-to person stays, however long ago");
	assert(list.every((entry) => entry.email.includes("@") && entry.email === entry.email.toLowerCase()));
});

const book = [
	{ email: "maya@example.com", name: "Maya Chen", sends: 9, lastSentAt: 1, lastSeenAt: 1, source: "outbound" },
	{ email: "gvozdar@example.com", name: "Petar Gvožđar", sends: 5, lastSentAt: 1, lastSeenAt: 1, source: "outbound" },
	{ email: "j.mueller@firma.example", name: "Jürgen Müller", sends: 4, lastSentAt: 1, lastSeenAt: 1, source: "manual" },
	{ email: "max@example.com", name: null, sends: 3, lastSentAt: 1, lastSeenAt: 1, source: null },
	{ email: "ada@other.example", name: "Ada Smith", sends: 2, lastSentAt: 1, lastSeenAt: 1, source: "inbound" },
	{ email: "mayflower@example.com", name: "Mayflower Tours", sends: 1, lastSentAt: 1, lastSeenAt: 1, source: "inbound" },
];
const emails = (query, exclude = new Set(), limit) => app.suggestRecipients(book, query, exclude, limit).map((entry) => entry.email);

test("typing the start of a name, of a later word of it, or of the address finds a person", () => {
	assert.deepEqual(emails("ma"), ["maya@example.com", "max@example.com", "mayflower@example.com"]);
	assert.deepEqual(emails("chen"), ["maya@example.com"]);
	assert.deepEqual(emails("m c"), ["maya@example.com"]);
	assert.deepEqual(emails("smith"), ["ada@other.example"]);
	assert.deepEqual(emails("j.mue"), ["j.mueller@firma.example"]);
});

test("matching ignores case and accents", () => {
	assert.deepEqual(emails("GVOZ"), ["gvozdar@example.com"]);
	assert.deepEqual(emails("muller"), ["j.mueller@firma.example"]);
	assert.deepEqual(emails("Jürgen mü"), ["j.mueller@firma.example"]);
});

test("an address being typed is compared with addresses only", () => {
	assert.deepEqual(emails("ada@"), ["ada@other.example"]);
	assert.deepEqual(emails("ada@ex"), [], "ada@ex is not Ada Smith at another address");
	assert.deepEqual(emails("chen@"), []);
});

test("nothing is suggested for nothing typed, and chosen recipients are not offered again", () => {
	assert.deepEqual(emails(""), []);
	assert.deepEqual(emails("   "), []);
	assert.deepEqual(emails("x".repeat(201)), []);
	assert.deepEqual(emails("ma", new Set(["maya@example.com"])), ["max@example.com", "mayflower@example.com"]);
	assert.deepEqual(emails("ma", new Set(), 1), ["maya@example.com"], "the list is cut in ranked order");
	assert.deepEqual(emails("xyz"), []);
});

test("a chosen suggestion becomes a recipient that the composer accepts and can show", () => {
	const chip = app.candidateToRecipient({ email: "o.brien@example.com", name: 'Pat "The Cat" O\'Brien, Jr.' });
	assert.equal(app.isValidRecipient(chip), true);
	assert.equal(app.getRecipientLabel(chip), 'Pat "The Cat" O\'Brien, Jr.');
	assert.deepEqual(app.headerToRecipients(app.recipientsToHeader([chip, "max@example.com"])), [chip, "max@example.com"]);
	assert.equal(app.candidateToRecipient({ email: "max@example.com", name: null }), "max@example.com");
	assert.equal(app.candidateToRecipient({ email: "max@example.com", name: "MAX@example.com" }), "max@example.com");
	assert.deepEqual([...app.recipientAddressSet(["Maya <MAYA@example.com>"], ["dev@example.com"])], ["maya@example.com", "dev@example.com"]);
});
