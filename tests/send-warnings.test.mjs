// What the composer asks about before a message goes: each rule, when it asks and, as much, when it doesn't.
// All people and domains are invented.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-send-warnings-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/components/compose/send-warnings-utils.ts";
			export * from "./src/lib/email/confusables.ts";
		`,
		resolveDir: root,
		sourcefile: "send-warnings-entry.ts",
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

// Avery at Lumen writes to Maya and Dev there, to Lin at Harbor Works and to a friend at a public provider.
const facts = {
	own: ["avery@lumen.example"],
	known: ["maya.chen@lumen.example", "dev@lumen.example", "lin@harborworks.example", "friend.name@gmail.com", "sales1@vendor.example", "billing@microsoft-partner.example"],
	organisationDomains: ["lumen.example"],
};
const warn = (to, extra = {}) => app.getSendWarnings({ to, cc: [], bcc: [], facts, ...extra });
const kinds = (warnings) => warnings.map((warning) => warning.kind);

test("a domain one letter away from a known correspondent's is asked about", () => {
	assert.deepEqual(warn(["lin@harborwork.example"]), [{ kind: "lookalike", address: "lin@harborwork.example", like: "harborworks.example" }]);
	assert.deepEqual(warn(["lin@harborworsk.example"])[0]?.like, "harborworks.example", "two letters swapped");
	assert.deepEqual(warn(["Lin <LIN@HarborWorks.example>"]), [], "the known address itself, in any case and with a name");
});

test("look-alike characters in a domain are caught whatever the script", () => {
	assert.equal(warn(["lin@harb0rworks.example"])[0]?.like, "harborworks.example", "zero for o");
	assert.equal(warn(["lin@harborworкs.example"])[0]?.like, "harborworks.example", "Cyrillic к");
	assert.equal(warn(["billing@rnicrosoft-partner.example"])[0]?.like, "microsoft-partner.example", "rn reads as m");
	assert.equal(warn(["lin@harbor​works.example"]).length, 0, "an invisible character changes nothing about where mail goes");
});

test("a mailbox one letter away from a known one at the same domain is asked about", () => {
	assert.deepEqual(warn(["maya.chem@lumen.example"]), [{ kind: "lookalike", address: "maya.chem@lumen.example", like: "maya.chen@lumen.example" }]);
	assert.equal(warn(["freind.name@gmail.com"])[0]?.like, "friend.name@gmail.com");
});

test("ordinary new recipients are not asked about", () => {
	assert.deepEqual(warn(["someone.new@lumen.example"]), [], "a new colleague");
	assert.deepEqual(warn(["contact@unrelated-company.example"]), [], "a new company");
	assert.deepEqual(warn(["sales2@vendor.example"]), [], "numbered mailboxes are neighbours, not lookalikes");
	assert.deepEqual(warn(["dan@lumen.example"]), [], "short names are one letter from many others");
	assert.deepEqual(warn(["friend.name+orders@gmail.com", "friendname@gmail.com"]), [], "a +tag and Gmail's dots are the same mailbox");
	assert.deepEqual(warn(["stranger@gmail.com", "stranger@outlook.com"]), [], "public providers are not lookalikes of each other");
	assert.deepEqual(warn(["not an address", "", "@", "a@"]), [], "broken entries are the validator's business");
});

test("a sender who only wrote to the owner does not make a lookalike domain known", () => {
	// The directory passes only people written to; an inbound-only harborwork.example stays unknown.
	assert.equal(warn(["lin@harborwork.example"]).length, 1);
	const afterReplying = { ...facts, known: [...facts.known, "lin@harborwork.example"] };
	assert.deepEqual(app.getSendWarnings({ to: ["lin@harborwork.example"], cc: [], bcc: [], facts: afterReplying }), [], "once written to on purpose, it is known");
});

const outsiders = ["a@one.example", "b@one.example", "c@two.example", "d@three.example", "e@three.example"];

test("five people outside the organisation at two or more domains, visible to each other, are asked about", () => {
	const [warning] = warn(outsiders.slice(0, 3), { cc: [...outsiders.slice(3), "dev@lumen.example"] });
	assert.deepEqual(warning, { kind: "outsiders", count: 5, domains: 3, addresses: outsiders });
});

test("outsiders are not asked about when they cannot see each other or already did", () => {
	assert.deepEqual(warn(["dev@lumen.example"], { bcc: outsiders }), [], "Bcc hides them");
	assert.deepEqual(warn(outsiders.slice(0, 4)), [], "four are a conversation");
	assert.deepEqual(warn(["a@one.example", "b@one.example", "c@one.example", "d@one.example", "e@one.example"]), [], "one other company");
	assert.deepEqual(warn(outsiders, { seen: outsiders.map((address) => address.toUpperCase()) }), [], "everyone was on the message being answered");
	assert.equal(warn(outsiders, { seen: outsiders.slice(0, 4) }).length, 1, "one newcomer has not seen the others");
	assert.deepEqual(warn(["maya.chen@lumen.example", "dev@lumen.example", "x@team.lumen.example", "y@lumen.example", "z@lumen.example", "q@lumen.example"]), [], "colleagues, subdomains included");
});

test("an owner with personal addresses only is never asked about outsiders", () => {
	const personal = { own: ["me@gmail.com"], known: [], organisationDomains: ["gmail.com"] };
	assert.deepEqual(app.getSendWarnings({ to: outsiders, cc: [], bcc: [], facts: personal }), [], "everybody would be outside, and every family mail asked about");
});

test("a recipient named in To and again in Bcc counts once and stays visible", () => {
	const [warning] = warn(outsiders, { bcc: ["A@one.example"] });
	assert.equal(warning.count, 5);
});

test("a message that speaks of an attachment and has none is asked about", () => {
	for (const text of ["Anbei die Rechnung.", "Im Anhang finden Sie das Angebot", "Please find the report attached.", "I've attached the slides", "Voir la pièce jointe", "siehe Anhang"]) {
		assert.deepEqual(kinds(warn(["dev@lumen.example"], { bodyText: text })), ["missingAttachment"], text);
	}
});

test("no attachment question when a file is attached or the word is part of another", () => {
	assert.deepEqual(warn(["dev@lumen.example"], { bodyText: "Anbei die Rechnung.", hasAttachments: true }), []);
	for (const text of ["", "Bis morgen!", "Der Zusammenhang ist klar.", "We discussed attachmentless delivery.", "Das hängt davon ab."]) {
		assert.deepEqual(warn(["dev@lumen.example"], { bodyText: text }), [], text);
	}
});

test("lookalikes come first, in recipient order, and at most twenty are said", () => {
	const many = Array.from({ length: 30 }, (_, index) => `person${index}@harborwork.example`);
	const warnings = warn(["maya.chem@lumen.example", ...many], { cc: outsiders, bodyText: "siehe Anhang" });
	assert.equal(warnings.filter((warning) => warning.kind === "lookalike").length, 20);
	assert.equal(warnings[0].address, "maya.chem@lumen.example");
	assert.deepEqual(kinds(warnings).slice(20), ["outsiders", "missingAttachment"]);
});

test("more recipients than are checked is itself asked about, and the check stays fast", () => {
	const crowd = Array.from({ length: 1500 }, (_, index) => `member${index}@lumen.example`);
	const bigFacts = { ...facts, known: Array.from({ length: 5000 }, (_, index) => `customer${index}@company${index % 700}.example`) };
	const started = performance.now();
	const warnings = app.getSendWarnings({ to: crowd, cc: [], bcc: [], facts: bigFacts });
	assert.deepEqual(warnings, [{ kind: "tooManyRecipients", checked: 1000 }]);
	assert(performance.now() - started < 5000, "bounded work for the largest message and address book");
});

test("one edit means one insert, delete, replace or adjacent swap, and nothing more", () => {
	// Reference: restricted Damerau-Levenshtein distance.
	const distance = (a, b) => {
		const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
		for (let j = 0; j <= b.length; j++) rows[0][j] = j;
		for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
			rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
		}
		return rows[a.length][b.length];
	};
	let seed = 7;
	const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
	const word = () => Array.from({ length: random(7) }, () => "abc"[random(3)]).join("");
	for (let round = 0; round < 20000; round++) {
		const a = word(), b = word();
		assert.equal(app.withinOneEdit(a, b), distance(a, b) <= 1, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
	}
});

test("the registrable domain and public providers are recognised", () => {
	assert.equal(app.registrableDomain("Mail.Sub.Example.CO.UK."), "example.co.uk");
	assert.equal(app.registrableDomain("a.b.example.com"), "example.com");
	assert.equal(app.registrableDomain("localhost"), "localhost");
	assert.equal(app.isMailProviderDomain("mail.gmail.com"), true);
	assert.equal(app.isMailProviderDomain("lumen.example"), false);
	assert.equal(app.skeleton("PАYPA1"), app.skeleton("paypal"), "Cyrillic А and the digit 1");
	assert.equal(app.skeleton("Müller"), "muller");
});
