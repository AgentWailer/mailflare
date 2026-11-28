// Who had already seen each other when a reply was started, kept beside the draft on this device.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); } };
const bundle = await build({ entryPoints: ["src/components/compose/reply-seen-utils.ts"], bundle: true, write: false, platform: "browser", format: "esm", tsconfig: "tsconfig.json" });
const { replyStartRecipients, forgetReplyStartRecipients } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("a reply reopened later knows only the people on the answered message", () => {
	assert.deepEqual(replyStartRecipients("draft-1", ["a@one.example", "b@two.example"]), ["a@one.example", "b@two.example"]);
	// The draft was saved with five more people since; reopening it does not make them old acquaintances.
	assert.deepEqual(replyStartRecipients("draft-1", null), ["a@one.example", "b@two.example"]);
	assert.deepEqual(replyStartRecipients("draft-2", null), [], "a reply started on another device: nobody is assumed, so the question is asked");
});

test("a sent reply is forgotten, a damaged store is treated as empty, and only the latest drafts are kept", () => {
	forgetReplyStartRecipients("draft-1");
	assert.deepEqual(replyStartRecipients("draft-1", null), []);
	storage.set("mailflare-reply-recipients", "{broken");
	assert.deepEqual(replyStartRecipients("draft-1", null), []);
	storage.set("mailflare-reply-recipients", "[1,2]");
	assert.deepEqual(replyStartRecipients("draft-1", null), []);
	for (let index = 0; index < 60; index++) replyStartRecipients(`many-${index}`, [`p${index}@example.com`]);
	assert.deepEqual(replyStartRecipients("many-0", null), [], "the oldest give way");
	assert.deepEqual(replyStartRecipients("many-59", null), ["p59@example.com"]);
	assert.equal(Object.keys(JSON.parse(storage.get("mailflare-reply-recipients"))).length, 50);
	globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
	assert.deepEqual(replyStartRecipients("draft-9", ["a@one.example"]), ["a@one.example"], "without storage the reply still starts");
	assert.deepEqual(replyStartRecipients("draft-9", null), []);
});
