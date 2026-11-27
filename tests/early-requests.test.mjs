// Requests the page starts before the application has loaded: what the head script asks for, and
// when the application takes such an answer instead of asking again.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "https://mailflare.test/inbox" });
for (const key of ["window", "localStorage", "CustomEvent", "Event"]) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
const dir = mkdtempSync(join(process.cwd(), "node_modules", "mailflare-early-requests-"));
after(() => { dom.window.close(); rmSync(dir, { recursive: true, force: true }); });
await build({
	stdin: { contents: `export * from './src/lib/auth/early-requests';export * from './src/lib/auth/client';export { getUserTimeZone } from './src/lib/time/utils';`, resolveDir: process.cwd() },
	outfile: join(dir, "app.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: "tsconfig.json", logLevel: "silent",
});
const app = await import(pathToFileURL(join(dir, "app.mjs")).href);

/** Runs the head script in a page of its own with the given storage and address. */
function startPage({ storage = {}, page = "/inbox", fetch: fetchImpl } = {}) {
	const requested = [];
	const window = {};
	const context = {
		window,
		location: { pathname: page.split("?")[0], search: page.includes("?") ? page.slice(page.indexOf("?")) : "" },
		localStorage: { getItem: (key) => (Object.hasOwn(storage, key) ? storage[key] : null) },
		Intl, JSON, Date, Array, Promise,
		fetch: fetchImpl ?? ((url, init) => { requested.push({ url, init }); return Promise.resolve(new Response(url)); }),
	};
	runInNewContext(app.earlyRequestsBootstrapScript, context);
	return { requested, early: window.__mailflareEarly };
}
const list = "/api/messages?folder=inbox&mailboxId=box&timeZone=Europe%2FBerlin&limit=25&group=thread";
const noted = (scope, lists) => JSON.stringify({ scope, lists });

test("the head script starts nothing for a browser that was never signed in", () => {
	const visitor = startPage();
	assert.deepEqual(visitor.requested, []);
	assert.equal(visitor.early, undefined);
	// A marker left by an older version is not a session either; the application replaces it first.
	assert.deepEqual(startPage({ storage: { "mailflare-session-scope": "scope:a", "mailflare-session-token": "legacy" } }).requested, []);
	// Storage that cannot be read must not stop the page.
	const context = { window: {}, location: { pathname: "/inbox", search: "" }, localStorage: { getItem() { throw new Error("blocked"); } }, Intl, JSON, Date, fetch() { throw new Error("must not be called"); } };
	runInNewContext(app.earlyRequestsBootstrapScript, context);
	assert.equal(context.window.__mailflareEarly, undefined);
});

test("a signed-in browser asks for its session and mailboxes, and for the list this page showed first last time", () => {
	const scope = "scope:a";
	const first = startPage({ storage: { "mailflare-session-scope": scope } });
	assert.deepEqual(first.requested.map((request) => request.url), ["/api/auth/me", "/api/mailboxes"]);
	assert.equal(first.early.scope, scope);
	for (const { init } of first.requested) {
		assert.equal(init.credentials, "same-origin");
		assert.equal(init.headers["X-Time-Zone"], Intl.DateTimeFormat().resolvedOptions().timeZone);
		assert.equal(init.headers.Authorization, undefined);
	}
	assert.equal(first.requested[0].init.cache, "no-store", "the session is always validated live");

	const storage = { "mailflare-session-scope": scope, "mailflare-user-time-zone": JSON.stringify({ timeZone: "Europe/Berlin" }), "mailflare-start-requests": noted(scope, [["/sent", "/api/messages?folder=sent"], ["/inbox", list]]) };
	const returning = startPage({ storage });
	assert.deepEqual(returning.requested.map((request) => request.url), ["/api/auth/me", "/api/mailboxes", list]);
	assert.equal(returning.requested[2].init.headers["X-Time-Zone"], "Europe/Berlin");
	assert.deepEqual(Object.keys(returning.early.requests), ["/api/auth/me", "/api/mailboxes", list]);
	// Another page of the app has its own list, or none.
	assert.deepEqual(startPage({ storage, page: "/sent" }).requested.map((request) => request.url).at(-1), "/api/messages?folder=sent");
	assert.equal(startPage({ storage, page: "/settings" }).requested.length, 2);
	assert.equal(startPage({ storage, page: "/inbox?q=invoice" }).requested.length, 2, "a page address with a search is another page");
});

test("what storage says is only ever used as an address of the message list of the same session", () => {
	const scope = "scope:a";
	const withNote = (note) => startPage({ storage: { "mailflare-session-scope": scope, "mailflare-start-requests": note } }).requested.map((request) => request.url);
	const only = ["/api/auth/me", "/api/mailboxes"];
	assert.deepEqual(withNote(noted("scope:other", [["/inbox", list]])), only, "a list noted under another session");
	for (const url of ["https://evil.example/api/messages?x", "//evil.example/api/messages?x", "/api/send", "/api/messagesX?folder=inbox", "/api/messages", "javascript:alert(1)", "", null, 7, {}, [list], `/api/messages?${"x".repeat(3000)}`]) {
		assert.deepEqual(withNote(noted(scope, [["/inbox", url]])), only, `not a list address: ${String(url).slice(0, 40)}`);
	}
	for (const note of ["", "null", "{", "[]", "7", JSON.stringify({ scope }), JSON.stringify({ scope, lists: "x" }), JSON.stringify({ scope, lists: [null, 3, "x", {}, ["/inbox"]] })]) {
		assert.deepEqual(withNote(note), only, `unreadable note: ${note.slice(0, 30)}`);
	}
});

test("a request that fails early is silent until someone asks for it", async () => {
	const failed = startPage({ storage: { "mailflare-session-scope": "scope:a" }, fetch: () => Promise.reject(new TypeError("offline")) });
	await assert.rejects(failed.early.requests["/api/auth/me"], /offline/);
	await new Promise((resolve) => setTimeout(resolve, 10));
	// A time zone that cannot be a header value makes `fetch` throw; the page still loads.
	const thrown = startPage({ storage: { "mailflare-session-scope": "scope:a" }, fetch: () => { throw new TypeError("invalid header"); } });
	assert.equal(thrown.early, undefined);
});

/** Puts early answers where the head script would, for the current session and time zone. */
function giveEarly(urls, { scope = app.getClientSessionToken(), zone = app.getUserTimeZone(), at = Date.now(), make = (url) => Promise.resolve(Response.json({ early: url })) } = {}) {
	window.__mailflareEarly = { scope, zone, at, requests: Object.fromEntries(urls.map((url) => [url, make(url)])) };
}
function signIn() {
	localStorage.clear();
	app.setClientSessionToken("signed-in");
	return app.getClientSessionToken();
}

test("the application takes an early answer once, and only for the very request it stands for", async (t) => {
	signIn();
	const sent = [];
	t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url: String(url), init }); return Response.json({ early: null }); });
	giveEarly(["/api/mailboxes", list]);

	assert.deepEqual(await (await app.authFetch("/api/mailboxes", { early: true })).json(), { early: "/api/mailboxes" });
	assert.equal(sent.length, 0, "no second request for what the page already asked");
	assert.deepEqual(await (await app.authFetch("/api/mailboxes", { early: true })).json(), { early: null }, "an answer is handed out once");
	assert.equal(sent.length, 1);

	// Without the caller saying so, nothing is taken: a forced refresh must reach the server.
	assert.deepEqual(await (await app.authFetch(list, { cache: "no-store" })).json(), { early: null });
	// Another address, a write, or a request with headers of its own is not the early one.
	assert.deepEqual(await (await app.authFetch(`${list}&offset=25`, { early: true })).json(), { early: null });
	assert.deepEqual(await (await app.authFetch(list, { early: true, method: "POST", body: "{}" })).json(), { early: null });
	assert.deepEqual(await (await app.authFetch(list, { early: true, headers: { "X-Mailflare-Preload": "1" } })).json(), { early: null });
	assert.deepEqual(await (await app.authFetch(new Request(`https://mailflare.test${list}`), { early: true })).json(), { early: null });
	assert.deepEqual(await (await app.authFetch(list, { early: true })).json(), { early: list }, "still there for the request it stands for");
});

test("an early answer from another session, another time zone or too long ago is never used", async (t) => {
	const scope = signIn();
	let sent = 0;
	t.mock.method(globalThis, "fetch", async () => { sent++; return Response.json({ early: null }); });
	const take = async () => (await (await app.authFetch("/api/mailboxes", { early: true })).json()).early;

	giveEarly(["/api/mailboxes"], { scope: "scope:someone-else" });
	assert.equal(await take(), null);
	assert.equal(window.__mailflareEarly, undefined, "the whole start is dropped");

	giveEarly(["/api/mailboxes"], { zone: "Pacific/Kiritimati" });
	assert.equal(await take(), null);

	giveEarly(["/api/mailboxes"], { at: Date.now() - app.EARLY_MAX_AGE_MS - 1 });
	assert.equal(await take(), null);
	giveEarly(["/api/mailboxes"], { at: Date.now() + 60_000 });
	assert.equal(await take(), null, "a clock that went backwards");
	assert.equal(sent, 4);

	// Signing in as someone else, or out, drops answers under way and the noted lists.
	giveEarly(["/api/mailboxes"]);
	localStorage.setItem(app.START_REQUESTS_KEY, noted(scope, [["/inbox", list]]));
	app.setClientSessionToken("other-account");
	assert.equal(window.__mailflareEarly, undefined);
	assert.equal(localStorage.getItem(app.START_REQUESTS_KEY), null);
	giveEarly(["/api/mailboxes"]);
	app.clearClientSessionToken();
	assert.equal(window.__mailflareEarly, undefined);

	// Signed out, nothing is taken even if something were there.
	window.__mailflareEarly = { scope: null, zone: app.getUserTimeZone(), at: Date.now(), requests: { "/api/mailboxes": Promise.resolve(Response.json({ early: "x" })) } };
	assert.equal(await take(), null);
	// Whatever else sits in that place is not an answer.
	for (const junk of ["text", 7, { requests: null }, { scope: app.getClientSessionToken(), zone: app.getUserTimeZone(), at: Date.now(), requests: { "/api/mailboxes": "not a promise" } }]) {
		signIn();
		window.__mailflareEarly = junk;
		assert.equal(await take(), null);
	}
});

test("a failed or slow early request falls back to an ordinary one, within the caller's own limit", async (t) => {
	signIn();
	let sent = 0;
	t.mock.method(globalThis, "fetch", async (_url, init) => { sent++; init?.signal?.throwIfAborted(); return Response.json({ early: null }); });

	giveEarly(["/api/mailboxes"], { make: () => { const failed = Promise.reject(new TypeError("offline")); failed.catch(() => {}); return failed; } });
	assert.deepEqual(await (await app.authFetch("/api/mailboxes", { early: true })).json(), { early: null });
	assert.equal(sent, 1);

	// An early request that never answers does not outlast the caller's signal.
	giveEarly(["/api/auth/me"], { make: () => new Promise(() => {}) });
	const controller = new AbortController();
	const waiting = app.authFetch("/api/auth/me", { early: true, signal: controller.signal });
	controller.abort(new DOMException("timed out", "TimeoutError"));
	await assert.rejects(waiting, /timed out/);

	// An unauthorized early answer ends the session exactly as an ordinary one does.
	signIn();
	giveEarly(["/api/mailboxes"], { make: () => Promise.resolve(new Response("{}", { status: 401 })) });
	const response = await app.authFetch("/api/mailboxes", { early: true, redirectOnUnauthorized: false });
	assert.equal(response.status, 401);
});

test("a page notes the list it shows first, once, and never a search or a later page", () => {
	const scope = signIn();
	const stored = () => JSON.parse(localStorage.getItem(app.START_REQUESTS_KEY));
	const visit = (page, url, as = scope) => { dom.reconfigure({ url: `https://mailflare.test${page}` }); app.resetStartListMemory(); app.rememberStartList(url, as); };

	visit("/inbox", list);
	assert.deepEqual(stored(), { scope, lists: [["/inbox", list]] });
	// Later lists of the same page load (another folder, another mailbox) are not what a start begins with.
	app.rememberStartList("/api/messages?folder=sent", scope);
	assert.deepEqual(stored().lists, [["/inbox", list]]);

	for (const url of [`${list}&q=tax+return`, "/api/messages?title=Offer", `${list}&offset=25`]) {
		localStorage.removeItem(app.START_REQUESTS_KEY);
		visit("/inbox", url);
		assert.equal(localStorage.getItem(app.START_REQUESTS_KEY), null, "search words and later pages stay out of storage");
	}
	for (const [url, as] of [["/api/send", scope], ["https://evil.example/api/messages?x=1", scope], [list, null]]) {
		visit("/inbox", url, as);
		assert.equal(localStorage.getItem(app.START_REQUESTS_KEY), null);
	}

	// One list per page, the newest pages first, and only a handful of them.
	for (const page of ["/inbox", "/sent", "/drafts", "/starred", "/all", "/trash", "/spam", "/inbox"]) visit(page, `/api/messages?folder=${page.slice(1)}`);
	assert.deepEqual(stored().lists.map(([page]) => page), ["/inbox", "/spam", "/trash", "/all", "/starred", "/drafts"]);
	assert.equal(stored().lists.filter(([page]) => page === "/inbox").length, 1);

	// Lists noted by a previous session are not carried into the next.
	const next = signIn();
	visit("/sent", "/api/messages?folder=sent", next);
	assert.deepEqual(stored(), { scope: next, lists: [["/sent", "/api/messages?folder=sent"]] });

	// The note and the head script agree: what one writes, the other asks for.
	const started = startPage({ storage: { "mailflare-session-scope": next, "mailflare-start-requests": localStorage.getItem(app.START_REQUESTS_KEY) }, page: "/sent" });
	assert.deepEqual(started.requested.map((request) => request.url), ["/api/auth/me", "/api/mailboxes", "/api/messages?folder=sent"]);
});
