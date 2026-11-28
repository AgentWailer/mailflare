// What the reader says about a sender: the usual fraud is caught, ordinary mail is left alone.
// All people and domains are invented.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("").window.DOMParser;
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); } };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-sender-warnings-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: { contents: `export * from "./src/components/messages/sender-warnings-utils.ts";export { isMailProviderDomain } from "./src/lib/email/confusables.ts";export { hasAuthoredPicture } from "./src/components/compose/rich-text-utils.ts";export { isKnownCorrespondent } from "./src/components/compose/use-recipient-directory.ts";`, resolveDir: root, sourcefile: "sender-warnings-entry.ts" },
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", tsconfig: join(root, "tsconfig.json"), packages: "external", logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);

// Steffen at Lumen writes to Maya (a colleague), Lin at Harbor Works and a friend at a public provider.
const facts = {
	known: [{ email: "maya.chen@lumen.example", name: "Maya Chen" }, { email: "lin@harborworks.example", name: "Lin Okoro" }, { email: "friend.name@gmail.com", name: "Jo Friend" }, { email: "support@vendor.example", name: "Support" }],
	own: ["steffen@lumen.example"],
	ownNames: ["Steffen Beispiel"],
	organisationDomains: ["lumen.example"],
};
const check = (fromAddr, extra = {}) => app.getSenderWarnings({ fromAddr, facts, ...extra });
const kinds = (warnings) => warnings.map((warning) => warning.kind);

test("a known colleague's name on a strange address is said, with the address she really writes from", () => {
	assert.deepEqual(check('"Maya Chen" <maya.chen@lumen-example.example>'), [{ kind: "nameOfKnownPerson", name: "Maya Chen", knownAddress: "maya.chen@lumen.example" }]);
	assert.deepEqual(kinds(check('"CHEN, Maya" <ceo.office@gmail.com>')), ["nameOfKnownPerson"], "word order, case and punctuation do not hide the name");
	assert.deepEqual(kinds(check("Máyà Chén <someone@elsewhere.example>")), ["nameOfKnownPerson"], "nor do accents");
});

test("mail under the owner's own name from a foreign address is said", () => {
	assert.deepEqual(check('"Steffen Beispiel" <steffen.beispiel@mail-service.example>'), [{ kind: "ownName", name: "Steffen Beispiel" }]);
	assert.deepEqual(check('"Steffen Beispiel" <steffen@lumen.example>'), [], "the owner's own address");
	assert.deepEqual(check('"Steffen Beispiel" <noreply@lumen.example>'), [], "a system of the owner's own organisation");
});

test("a display name written as somebody else's address is said, whoever the sender is", () => {
	assert.deepEqual(check('"maya.chen@lumen.example" <thief@elsewhere.example>'), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	assert.deepEqual(kinds(check('"Maya Chen (maya.chen@lumen.example)" <thief@elsewhere.example>')), ["nameIsOtherAddress"], "inside a longer name too");
	// Forms of @ and . that are drawn the same, and characters that draw nothing, hide nothing.
	assert.deepEqual(check('"maya.chen＠lumen.example" <thief@elsewhere.example>'), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	assert.deepEqual(check('"maya.chen﹫lumen．example" <thief@elsewhere.example>'), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	assert.deepEqual(check('"maya.chen@\u200blumen.example" <thief@elsewhere.example>'), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	assert.deepEqual(check('"thief@elsewhere.example for maya.chen@lumen.example" <thief@elsewhere.example>'), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }], "every address in the name is looked at, not only the first");
	// Padding the name, or naming the real address many times first, pushes nothing out of sight.
	assert.deepEqual(check(`"${"x".repeat(400)} maya.chen@lumen.example" <thief@elsewhere.example>`), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	assert.deepEqual(check(`"${"thief@elsewhere.example ".repeat(20)}maya.chen@lumen.example" <thief@elsewhere.example>`), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	// Several at signs in one run of characters hide nothing either.
	assert.deepEqual(check('"x@maya.chen@lumen.example" <thief@elsewhere.example>'), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	assert.deepEqual(check('"thief@elsewhere.example@maya.chen@lumen.example" <thief@elsewhere.example>'), [{ kind: "nameIsOtherAddress", shown: "maya.chen@lumen.example" }]);
	const started = performance.now();
	check(`"${"a".repeat(90_000)}" <thief@elsewhere.example>`);
	check(`"${"a@".repeat(40_000)}" <thief@elsewhere.example>`);
	check(`"${"a.".repeat(40_000)}@" <thief@elsewhere.example>`);
	assert(performance.now() - started < 3000, "a name of any length and shape is read in linear time");
	assert.deepEqual(check('"news@shop.example" <news@shop.example>'), [], "the sender's own address as its name is harmless");
	assert.deepEqual(check('"NEWS@Shop.example" <news@shop.example>'), []);
	assert.deepEqual(check('"Preise ab 5@Stück" <news@shop.example>'), [], "an @ alone is no address");
});

test("a lookalike address or domain is said", () => {
	assert.deepEqual(check("lin@harborwork.example"), [{ kind: "lookalike", like: "harborworks.example" }]);
	assert.deepEqual(check("Rechnung <billing@harb0rworks.example>"), [{ kind: "lookalike", like: "harborworks.example" }]);
	assert.deepEqual(kinds(check('"Maya Chen" <maya.chem@lumen.example>')), ["lookalike"], "one letter off at the same organisation");
});

test("ordinary senders are left alone", () => {
	assert.deepEqual(check('"Maya Chen" <maya.chen@lumen.example>'), [], "the known address");
	assert.deepEqual(check('"Maya Chen" <maya@lumen.example>'), [], "another address of the same person at the same organisation");
	assert.deepEqual(check('"Newsletter" <news@shop.example>'), [], "a stranger with a name of their own");
	assert.deepEqual(check('"Support" <support@other-vendor.example>'), [], "a one-word name is shared by many senders");
	assert.deepEqual(check('"Anna Schmidt" <anna@kanzlei.example>'), [], "a new person");
	assert.deepEqual(check("no-reply@service.example"), [], "no name at all");
	assert.deepEqual(check(""), []);
	assert.deepEqual(check("not an address"), []);
	assert.deepEqual(app.getSenderWarnings({ fromAddr: '"Maya Chen" <x@y.example>', facts: { known: [], own: [], ownNames: [], organisationDomains: [] } }), [], "with an empty address book nobody is known to be impersonated");
});

test("replies that would leave for a throwaway mailbox are said, ordinary reply addresses are not", () => {
	assert.deepEqual(check('"Buchhaltung" <rechnung@firma.example>', { replyTo: "firma.buchhaltung.2026@gmail.com" }), [{ kind: "replyElsewhere", replyTo: "firma.buchhaltung.2026@gmail.com" }]);
	assert.deepEqual(check('"Shop" <news@shop.example>', { replyTo: "service@shop-support.example" }), [], "a help desk at another company domain is common");
	assert.deepEqual(check('"Shop" <news@mail.shop.example>', { replyTo: "service@shop.example" }), [], "the same organisation");
	assert.deepEqual(check('"Jo" <jo@gmail.com>', { replyTo: "jo.other@outlook.com" }), [], "a private person between private mailboxes");
	assert.deepEqual(check('"Shop" <news@shop.example>', { replyTo: "friend.name@gmail.com" }), [], "replies to somebody the owner writes to");
});

const fraud = '<p>Die Bankdaten findest du <a href="https://lumen-example.example/zahlung">hier im Portal: https://lumen.example/zahlung</a>.</p>';

test("a link that shows one site and leads to another is added to a warning, and never stands alone", () => {
	assert.deepEqual(check('"Maya Chen" <maya.chen@lumen-example.example>', { html: fraud }).at(-1), { kind: "deceptiveLink", shown: "lumen.example", target: "lumen-example.example" });
	// A newsletter's tracked links are honest and everywhere; on their own they are not a reason to ask.
	assert.deepEqual(check('"Fahrradladen" <news@fahrradladen.example>', { html: '<a href="https://click.mailservice.example/t/abc">www.fahrradladen.example</a>' }), []);
});

test("links are compared by the site they name", () => {
	const link = (href, text) => app.findDeceptiveLink(`<a href="${href}">${text}</a>`);
	assert.deepEqual(link("https://evil.example/login", "https://bank.example/login"), { shown: "bank.example", target: "evil.example" });
	assert.deepEqual(link("https://evil.example", "www.bank.example"), { shown: "bank.example", target: "evil.example" });
	assert.deepEqual(link("https://bank.example.evil.example/x", "bank.example"), { shown: "bank.example", target: "bank.example.evil.example" });
	assert.equal(link("https://www.bank.example/konto?x=1", "bank.example"), null, "the same site");
	assert.equal(link("https://login.bank.example/", "https://www.bank.example"), null, "a subdomain of the same site");
	assert.equal(link("https://evil.example", "Hier klicken"), null, "ordinary words name no site");
	assert.equal(link("https://evil.example", "Version 2.0 ist da"), null);
	assert.equal(link("mailto:a@bank.example", "evil.example"), null, "not a web link");
	assert.equal(link("https://[bad", "bank.example"), null, "a broken address is skipped");
	assert.equal(app.findDeceptiveLink(null), null);
	assert.equal(app.findDeceptiveLink("<a>no href</a><a href='#top'>bank.example</a>"), null);
	const many = Array.from({ length: 5000 }, (_, index) => `<a href="https://shop.example/${index}">Artikel ${index}</a>`).join("");
	const started = performance.now();
	assert.equal(app.findDeceptiveLink(many + '<a href="https://evil.example">bank.example</a>'), null, "only the first few hundred links are read");
	assert(performance.now() - started < 5000);
});

test("a known person's name on another address at the same public mail provider is said", () => {
	// Anyone can open an address at a public provider under any name: sharing gmail.com makes nobody a colleague.
	assert.deepEqual(check('"Jo Friend" <urgent.help.2026@gmail.com>'), [{ kind: "nameOfKnownPerson", name: "Jo Friend", knownAddress: "friend.name@gmail.com" }]);
	assert.deepEqual(check('"Jo Friend" <friend.name@gmail.com>'), [], "the address the owner writes to");
	assert.deepEqual(check('"Maya Chen" <m.chen@lumen.example>'), [], "a second address at her own organisation is still her");
});

test("a public provider is one whatever country ending it carries", () => {
	const regional = { ...facts, known: [...facts.known, { email: "anna.klein@yahoo.co.uk", name: "Anna Klein" }, { email: "paul.roux@outlook.fr", name: "Paul Roux" }] };
	const from = (fromAddr, extra = {}) => kinds(app.getSenderWarnings({ fromAddr, facts: regional, ...extra }));
	assert.deepEqual(from('"Anna Klein" <anna.klein.2026@yahoo.co.uk>'), ["nameOfKnownPerson"]);
	assert.deepEqual(from('"Paul Roux" <p.roux.urgent@outlook.fr>'), ["nameOfKnownPerson"]);
	assert.deepEqual(from('"Buchhaltung" <rechnung@firma.example>', { replyTo: "firma.buchhaltung@hotmail.co.uk" }), ["replyElsewhere"]);
	assert.deepEqual(from('"Maya Chen" <m.chen@lumen.example>'), [], "an organisation's own domain is still one organisation");
});

test("a mistyped or forged ending of a public provider is not the provider", () => {
	// gmail.co, outlook.cm and the like belong to whoever registered them. They must be compared, not waved through.
	for (const domain of ["gmail.co", "gmail.cm", "gmail.con", "hotmail.co", "outlook.cm", "yahoo.co", "live.io", "gmx.xyz"]) assert.equal(app.isMailProviderDomain(domain), false, domain);
	for (const domain of ["gmail.com", "yahoo.co.uk", "outlook.fr", "hotmail.co.uk", "gmx.es", "mail.yahoo.co.uk", "protonmail.ch"]) assert.equal(app.isMailProviderDomain(domain), true, domain);
	assert.deepEqual(kinds(check('"Jo" <friend.name@gmail.co>')), ["lookalike"], "mail from the look-alike of a friend's address is said");
	assert.deepEqual(kinds(check('friend.name@gmail.cm')), ["lookalike"]);
});

test("the checks that need nobody to compare with work with an empty address book", () => {
	const alone = { known: [], own: ["steffen@lumen.example"], ownNames: ["Steffen Beispiel"], organisationDomains: ["lumen.example"] };
	const lonely = (fromAddr, extra = {}) => kinds(app.getSenderWarnings({ fromAddr, facts: alone, ...extra }));
	assert.deepEqual(lonely('"chef@firma.example" <x@evil.example>'), ["nameIsOtherAddress"]);
	assert.deepEqual(lonely('"Steffen Beispiel" <steffen.beispiel@mail-service.example>'), ["ownName"]);
	assert.deepEqual(lonely('"Buchhaltung" <rechnung@firma.example>', { replyTo: "firma.buchhaltung.2026@gmail.com" }), ["replyElsewhere"]);
	assert.deepEqual(lonely('"Shop" <news@shop.example>'), [], "an ordinary stranger is left alone");
});

test("where the browser stores nothing, a mark still holds until the page is closed", () => {
	const real = globalThis.localStorage;
	globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
	try {
		app.trustSender("x@evil.example", "user:a");
		assert.deepEqual(app.readTrustedSenders("user:a"), ["x@evil.example"], "the button is not dead");
		assert.deepEqual(app.readTrustedSenders("user:b"), []);
		app.untrustSender("x@evil.example", "user:a");
		assert.deepEqual(app.readTrustedSenders("user:a"), []);
	} finally { globalThis.localStorage = real; }
});

test("a full store, which still reads but no longer writes, does not leave the button dead", () => {
	const real = globalThis.localStorage, kept = new Map([["mailflare-trusted-senders:user:full", '["old@example.com"]']]);
	globalThis.localStorage = { getItem: (key) => kept.get(key) ?? null, setItem() { throw new Error("QuotaExceededError"); } };
	try {
		app.trustSender("x@evil.example", "user:full");
		assert.deepEqual(app.readTrustedSenders("user:full"), ["x@evil.example", "old@example.com"], "the mark of this visit is read, not the older stored list");
		app.untrustSender("x@evil.example", "user:full");
		assert.deepEqual(app.readTrustedSenders("user:full"), ["old@example.com"]);
		// Once writing works again, the store is the truth again.
		globalThis.localStorage = { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => { kept.set(key, value); } };
		app.trustSender("y@evil.example", "user:full");
		assert.deepEqual(JSON.parse(kept.get("mailflare-trusted-senders:user:full")), ["y@evil.example", "old@example.com"]);
		assert.deepEqual(app.readTrustedSenders("user:full"), ["y@evil.example", "old@example.com"]);
	} finally { globalThis.localStorage = real; }
});

test("a mark is kept per account and can be taken back", () => {
	storage.clear();
	app.trustSender("x@evil.example", "box-a");
	assert.deepEqual(app.readTrustedSenders("box-a"), ["x@evil.example"]);
	assert.deepEqual(app.readTrustedSenders("box-b"), [], "another account at this browser decides for itself");
	assert.deepEqual(app.readTrustedSenders(), []);
	app.untrustSender(" X@Evil.example ", "box-a");
	assert.deepEqual(app.readTrustedSenders("box-a"), [], "the sender is warned about again");
	app.untrustSender("never@marked.example", "box-a");
	assert.deepEqual(app.readTrustedSenders("box-a"), []);
});

test("a sender marked as fine is remembered on the device", () => {
	assert.deepEqual(app.readTrustedSenders(), []);
	app.trustSender(" Maya.Chen@Lumen-Example.example ");
	app.trustSender("maya.chen@lumen-example.example");
	assert.deepEqual(app.readTrustedSenders(), ["maya.chen@lumen-example.example"]);
	storage.set("mailflare-trusted-senders", "{broken");
	assert.deepEqual(app.readTrustedSenders(), [], "a damaged list is treated as empty");
});

test("names are compared as people's names", () => {
	assert.equal(app.nameKey("Chen, Maya"), app.nameKey("maya CHEN"));
	assert.equal(app.nameKey("Dr. Jürgen Müller"), "dr jurgen muller");
	assert.equal(app.nameKey("Support"), null);
	assert.equal(app.nameKey("A B"), null);
	assert.equal(app.nameKey(null), null);
	assert.equal(app.nameKey("Maya​ Chen"), app.nameKey("Maya Chen"), "an invisible character changes nothing");
});

test("only a real send or a kept contact makes an address known", () => {
	const candidate = (sends, source) => ({ email: "lin@harborwork.example", name: null, sends, lastSentAt: null, lastSeenAt: 1, source });
	assert.equal(app.isKnownCorrespondent(candidate(1, "outbound")), true, "written to");
	assert.equal(app.isKnownCorrespondent(candidate(0, "manual")), true, "kept as a contact");
	// A send that was taken back or never left leaves the contact row behind, and nothing else.
	assert.equal(app.isKnownCorrespondent(candidate(0, "outbound")), false, "a look-alike must not become known by an undone send");
	assert.equal(app.isKnownCorrespondent(candidate(0, "inbound")), false, "somebody who only wrote to the owner");
	// While a message waits (undo window, scheduled time) its recipient is not known yet.
	assert.equal(app.isKnownCorrespondent({ ...candidate(1, "outbound"), delivered: 0 }), false);
	assert.equal(app.isKnownCorrespondent({ ...candidate(2, "outbound"), delivered: 1 }), true);
});

test("a picture counts as the writer's own only outside the signature and the quoted mail", () => {
	const signature = '<div data-mailflare-signature="1"><br><p>Grüße<br><img src="https://example.com/logo.png" alt="Logo"></p></div>';
	assert.equal(app.hasAuthoredPicture(signature), false, "the logo in the signature of an otherwise empty message");
	assert.equal(app.hasAuthoredPicture(`<blockquote><img src="cid:a"></blockquote>${signature}`), false, "a picture in the quoted original");
	assert.equal(app.hasAuthoredPicture(`<p><img src="data:image/png;base64,AAAA"></p>${signature}`), true, "a pasted picture");
	assert.equal(app.hasAuthoredPicture("<p>Text</p>"), false);
	assert.equal(app.hasAuthoredPicture(null), false);
});
