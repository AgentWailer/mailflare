import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-reply-recipients-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { getReplyRecipients } from "./src/components/message-actions/utils.ts";
			export { getMessageHeaderMetadata } from "./src/lib/email/unsubscribe.ts";
			export { parseRawMime } from "./src/lib/email/parse.ts";
		`,
		resolveDir: root,
		sourcefile: "reply-recipients-entry.ts",
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
const { getReplyRecipients, parseRawMime, getMessageHeaderMetadata } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const own = ["hello@example.com"];
const inbound = (fields) => ({
	direction: "inbound",
	fromAddr: "Website <no-reply@example.com>",
	toAddr: "hello@example.com",
	ccAddr: null,
	replyTo: null,
	providerMessageId: null,
	references: null,
	threadId: null,
	...fields,
});

test("a reply answers the sender when there is no Reply-To", () => {
	assert.deepEqual(getReplyRecipients(inbound({}), own, "reply"), { to: ["Website <no-reply@example.com>"], cc: [] });
});

test("a reply goes to every Reply-To address instead of the sender", () => {
	const message = inbound({ replyTo: "Visitor <visitor@example.net>, other@example.org" });
	assert.deepEqual(getReplyRecipients(message, own, "reply"), { to: ["Visitor <visitor@example.net>", "other@example.org"], cc: [] });
});

test("reply-all keeps the other recipients but not the From the Reply-To replaced", () => {
	const message = inbound({ replyTo: "visitor@example.net", toAddr: "hello@example.com, team@example.org", ccAddr: "boss@example.org" });
	assert.deepEqual(getReplyRecipients(message, own, "replyAll"), { to: ["visitor@example.net"], cc: ["team@example.org", "boss@example.org"] });
});

test("a Reply-To naming only the mailbox itself falls back to the sender", () => {
	const message = inbound({ replyTo: "hello@example.com" });
	assert.deepEqual(getReplyRecipients(message, own, "reply").to, ["Website <no-reply@example.com>"]);
});

test("the parser keeps the full Reply-To header", async () => {
	const raw = new TextEncoder().encode([
		"From: Website <no-reply@example.com>",
		"To: hello@example.com",
		"Reply-To: Visitor <visitor@example.net>, other@example.org",
		"Subject: Enquiry",
		"",
		"Hi",
	].join("\r\n")).buffer;
	assert.equal((await parseRawMime(raw)).replyTo, '"Visitor" <visitor@example.net>, other@example.org');
});

test("legacy Reply-To and unsubscribe share a bounded header read", async () => {
 let reads = 0;
 const raw = new TextEncoder().encode('Reply-To: Support <support@example.test>,\r\n other@example.test\r\nList-Unsubscribe: <https://example.test/unsubscribe>\r\n\r\nbody');
 const env = {BUCKET:{get:async (key, options) => { reads++; assert.equal(options.range.length, 65536); return {arrayBuffer:async()=>raw.buffer}; }}};
 const meta = await getMessageHeaderMetadata(env, 'private-key');
 assert.equal(reads, 1); assert.equal(meta.unsubscribeUrl, 'https://example.test/unsubscribe');
 assert.deepEqual(getReplyRecipients(inbound({replyTo:meta.replyTo}),own,'reply').to,['Support <support@example.test>','other@example.test']);
});

test('parsed headers retain Reply-To and unsubscribe without an R2 read, including absent headers',async()=>{
 for(const headers of ['Reply-To: Team <support@example.test>\r\nList-Unsubscribe: <javascript:bad>, <https://example.test/unsubscribe>\r\n','']){
  const raw=new TextEncoder().encode('From: sender@example.test\r\nTo: owner@example.test\r\n'+headers+'\r\nBody').buffer;
  const parsed=await parseRawMime(raw);
  const metadata=await getMessageHeaderMetadata({BUCKET:{get:()=>{throw Error('R2 must not be read');}}},'private',parsed.headerMetadata);
  assert.equal(metadata.unsubscribeUrl,headers?'https://example.test/unsubscribe':null);
  assert.equal(metadata.replyTo,parsed.replyTo);
 }
});

test('unknown, malformed or unsafe stored headers fall back to the bounded legacy reader',async()=>{
 for(const stored of ['{','{}','null',JSON.stringify({version:2,replyTo:null,unsubscribeUrl:null}),JSON.stringify({version:1,replyTo:null,unsubscribeUrl:'javascript:alert(1)'})]){
  let reads=0;const metadata=await getMessageHeaderMetadata({BUCKET:{get:async()=>{reads++;return null;}}},'private',stored);
  assert.equal(reads,1);assert.deepEqual(metadata,{unsubscribeUrl:null,replyTo:null});
 }
});
