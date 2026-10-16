import assert from "node:assert/strict";
import test, { after } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(process.cwd(), "node_modules", "mailflare-message-filter-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir,"headers.mjs"),"export async function cookies(){return {get:()=>undefined};}");
writeFileSync(join(dir,"vinext.mjs"),"export default {fetch:async()=>new Response()};");
writeFileSync(join(dir,"workers.mjs"),"export const env={};export class DurableObject{};");
await build({
	stdin:{contents:`
		export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
		export {applyMigrations} from './server/runtime/migrate.ts';
		export {createSession} from './src/lib/auth/session.ts';
		export {getDb} from './src/db/index.ts';
		export {POST as createLabel} from './src/app/api/folders/route.ts';
		export {POST as createRule,GET as listRules} from './src/app/api/routing-rules/route.ts';
		export {PATCH as updateRule,DELETE as deleteRule} from './src/app/api/routing-rules/[id]/route.ts';
		export {matchesRule,resolveInboxRuleDestination} from './src/lib/email/routing.ts';
		export {ruleMessageContent} from './src/lib/email/rule-content.ts';
		export {intakeIncomingMail} from './src/lib/email/intake.ts';
		export {processInboundMessage} from './src/lib/email/inbound.ts';
		export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';
		export {default as worker} from './worker.ts';
	`,resolveDir:process.cwd()},outfile:join(dir,"app.mjs"),bundle:true,platform:"node",format:"esm",packages:"external",tsconfig:"tsconfig.json",
	alias:{"next/headers":join(dir,"headers.mjs"),"next/server":"next/server.js","cloudflare:workers":join(dir,"workers.mjs"),"vinext/server/fetch-handler":join(dir,"vinext.mjs")},logLevel:"silent",
});
const app = await import(pathToFileURL(join(dir,"app.mjs")));
const verifiedTarget="forward@example.net";
const input = (overrides={}) => ({mailboxId:"box",sourceMessageId:"original",matchField:"sender",matchOperator:"exact",matchValue:"sender@example.org",conditions:[{field:"sender",operator:"exact",value:"sender@example.org",negate:false}],conditionMode:"all",labelIds:["work"],destination:"keep",enabled:true,priority:10,...overrides});
async function fixture(t){
	const DB=new app.SqliteDatabase(":memory:");
	const originalFetch=globalThis.fetch;
	t.after(()=>{DB.db.close();globalThis.fetch=originalFetch;delete globalThis.__mailflareNodeEnv;});
	await app.applyMigrations(DB,join(process.cwd(),"drizzle/migrations"));
	DB.db.exec(`
		INSERT INTO users(id,email,password_hash,name,role,created_at,spam_protection_enabled) VALUES
		('owner','owner@example.test','hash','Owner','user',1,0),('reader','reader@example.test','hash','Reader','user',1,0),('foreign','other@private.test','hash','Foreign','admin',1,0);
		INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','zone','active',1);
		INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('privatebox','foreign','domain','private','personal',1);
		INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES ('reader-access','reader','box','read_only',1);
		INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('work','owner','box','Work',1),('source','owner','box','Source domain',1),('private-label','foreign','privatebox','Private',1);
		INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,created_at) VALUES
		('original','owner','box','inbound','Sender <sender@example.org>','owner@example.test','Information','received',1),
		('foreign-message','foreign','privatebox','inbound','sender@example.org','private@example.test','Private','received',1),
		('sent-message','owner','box','outbound','owner@example.test','sender@example.org','Sent','sent',1);
	`);
	const objects=new Map(),queued=[],events=[];
	const env={DB,MAILFLARE_RUNTIME:"node",CF_TOKEN:"fixture-token",BUCKET:{put:async(key,raw)=>{objects.set(key,raw);},get:async(key)=>objects.has(key)?{arrayBuffer:async()=>objects.get(key)}:null,delete:async(key)=>objects.delete(key)},INBOUND_QUEUE:{send:async(payload)=>queued.push(payload)},REALTIME:{getByName:()=>({fetch:async(_url,init)=>{events.push(JSON.parse(init.body));return new Response();}})},AI:{run:async()=>({answers:{category:{type:"choice",choice:"primary",probabilities:{primary:0.95,promotions:0.02,social:0.02,spam:0.01}},action:{type:"noul",noul:0.01},security:{type:"noul",noul:0.01}}})}};
	globalThis.__mailflareNodeEnv=env;
	const cfRequests=[];
	globalThis.fetch=async(url)=>{
		const path=new URL(url).pathname;cfRequests.push(path);
		if(path==="/client/v4/zones/zone")return Response.json({success:true,result:{account:{id:"account"}}});
		if(path==="/client/v4/accounts/account/email/routing/addresses")return Response.json({success:true,result:[{email:verifiedTarget,verified:"2026-10-11"},{email:"unverified@example.net",verified:null}]});
		throw new Error("Unexpected request: "+path);
	};
	const tokens={};for(const id of ["owner","reader","foreign"])tokens[id]=await app.createSession(env,id);
	const request=(method,body,user="owner",path="/api/routing-rules")=>new Request("https://mailflare.test"+path,{method,headers:{Authorization:"Bearer "+tokens[user],"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
	return {DB,env,objects,queued,events,request,cfRequests,db:app.getDb(env)};
}
const mime=(recipient="owner@example.test",sender="sender@example.org")=>new TextEncoder().encode(`From: Sender <${sender}>\r\nTo: ${recipient}\r\nSubject: Information\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA sample message.\r\n--test\r\nContent-Type: text/plain; name="note.txt"\r\nContent-Disposition: attachment; filename="note.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--test--\r\n`).buffer;

test("a rule derived from a received message is mailbox scoped and combines with an existing source label",async(t)=>{
	const f=await fixture(t);
	f.DB.db.exec(`INSERT INTO routing_rules(id,user_id,domain_id,mailbox_id,scope,pattern,match_field,match_operator,match_value,label_ids,enabled,priority,created_at) VALUES ('source-rule','owner','domain','box','mailbox','@example.test','recipient','ends_with','@example.test','["source"]',1,10,1)`);
	const response=await app.createRule(f.request("POST",input({category:"promotions",skipInbox:true})));
	assert.equal(response.status,200);
	const result=await app.resolveInboxRuleDestination(f.db,{mailboxId:"box",toAddress:"owner@example.test",fromAddress:"Sender <sender@example.org>",subject:"Information"});
	assert.deepEqual(result.labelIds.sort(),["source","work"]);
	assert.equal(result.category,"promotions");assert.equal(result.status,"archived");
	assert.equal(f.DB.db.prepare("SELECT status FROM messages WHERE id='original'").get().status,"received");
	assert.equal(f.DB.db.prepare("SELECT count(*) n FROM message_labels WHERE message_id='original'").get().n,0);
});

test("rule creation refuses foreign, sent and missing source messages and read-only users without writes",async(t)=>{
	const f=await fixture(t);
	for(const sourceMessageId of ["foreign-message","sent-message","missing"])
		assert.equal((await app.createRule(f.request("POST",input({sourceMessageId})))).status,404);
	assert.equal((await app.createRule(f.request("POST",input(),"reader"))).status,404);
	assert.equal((await app.createRule(f.request("POST",input({labelIds:["private-label"]})))).status,404);
	const csrf=new Request("https://mailflare.test/api/routing-rules",{method:"POST",headers:{Origin:"https://foreign.test","Sec-Fetch-Site":"cross-site","Content-Type":"application/json"},body:JSON.stringify(input())});
	assert.ok([401,403].includes((await app.createRule(csrf)).status));
	assert.equal(f.DB.db.prepare("SELECT count(*) n FROM routing_rules").get().n,0);
});

test("forwarding requires a verified destination, prevents central catch-all loops and checks again on editing",async(t)=>{
	const f=await fixture(t);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:"unverified@example.net"})))).status,400);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:"unknown@example.net"})))).status,400);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:"owner@example.test"})))).status,400);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:verifiedTarget,destination:"spam"})))).status,400);
	const created=await app.createRule(f.request("POST",input({forwardTo:verifiedTarget})));assert.equal(created.status,200);
	const {id}=await created.json();
	const rule=f.DB.db.prepare("SELECT * FROM routing_rules WHERE id=?").get(id);
	assert.equal(rule.action,"forward");assert.equal(rule.forward_to,verifiedTarget);assert.equal(rule.keep_copy,1);
	assert.equal((await app.updateRule(f.request("PATCH",input({forwardTo:"unverified@example.net"}),"owner","/api/routing-rules/"+id),{params:Promise.resolve({id})})).status,400);
	assert.equal(f.DB.db.prepare("SELECT forward_to FROM routing_rules WHERE id=?").get(id).forward_to,verifiedTarget);
	globalThis.fetch=async()=>Response.json({success:false,errors:[{message:"Forbidden"}]},{status:403});
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:verifiedTarget})))).status,503);
	assert.equal(f.DB.db.prepare("SELECT count(*) n FROM routing_rules").get().n,1);
});

test("mailbox rule endpoints cannot overwrite or delete a domain catch-all",async(t)=>{
	const f=await fixture(t);
	f.DB.db.exec("INSERT INTO routing_rules(id,user_id,domain_id,mailbox_id,scope,pattern,created_at) VALUES ('catch-all','owner','domain','box','domain','*',1)");
	const params={params:Promise.resolve({id:"catch-all"})};
	assert.equal((await app.updateRule(f.request("PATCH",input()),params)).status,404);
	assert.equal((await app.deleteRule(f.request("DELETE"),params)).status,404);
	assert.equal(f.DB.db.prepare("SELECT scope FROM routing_rules WHERE id='catch-all'").get().scope,"domain");
});

test("an existing forwarding filter can be disabled during an API outage and cannot be re-enabled without verification",async(t)=>{
	const f=await fixture(t);
	const created=await app.createRule(f.request("POST",input({forwardTo:verifiedTarget})));assert.equal(created.status,200);
	const {id}=await created.json(),params={params:Promise.resolve({id})};
	globalThis.fetch=async()=>{throw new Error("Cloudflare temporarily unavailable");};
	assert.equal((await app.updateRule(f.request("PATCH",input({forwardTo:verifiedTarget,enabled:false})),params)).status,200);
	assert.equal(f.DB.db.prepare("SELECT enabled FROM routing_rules WHERE id=?").get(id).enabled,0);
	assert.equal((await app.updateRule(f.request("PATCH",input({forwardTo:verifiedTarget,enabled:true})),params)).status,503);
	assert.equal(f.DB.db.prepare("SELECT enabled FROM routing_rules WHERE id=?").get(id).enabled,0);
});

test("failed higher-priority forwarding does not silently choose a different filter's target",async(t)=>{
	const f=await fixture(t);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:verifiedTarget,priority:100})))).status,200);
	f.DB.db.exec(`INSERT INTO routing_rules(id,user_id,domain_id,mailbox_id,scope,pattern,match_field,match_operator,match_value,action,forward_to,enabled,priority,created_at) VALUES ('lower','owner','domain','box','mailbox','sender@example.org','sender','exact','sender@example.org','forward','different@example.net',1,1,1)`);
	const targets=[];
	const result=await app.intakeIncomingMail(f.env,{from:"sender@example.org",to:"owner@example.test",raw:mime(),headers:{}},{forward:async(target)=>{targets.push(target);return false;}});
	assert.deepEqual(targets,[verifiedTarget]);assert.equal(result.action,"store");assert.equal(f.queued.length,1);
});

test("a forwarding statistics failure preserves successful delivery and its local copy",async(t)=>{
	const f=await fixture(t);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:verifiedTarget})))).status,200);
	f.DB.db.exec(`UPDATE users SET forwarding_email='account-forward@example.net' WHERE id='owner';
		CREATE TRIGGER fail_statistics BEFORE UPDATE OF match_count ON routing_rules BEGIN SELECT RAISE(FAIL,'statistics unavailable'); END;`);
	const targets=[];
	const result=await app.intakeIncomingMail(f.env,{from:"sender@example.org",to:"owner@example.test",raw:mime(),headers:{}},{forward:async(target)=>{targets.push(target);return true;}});
	assert.deepEqual(targets,[verifiedTarget]);assert.equal(result.forwardedTo,verifiedTarget);
	assert.equal(result.action,"store");assert.equal(f.queued.length,1);assert.ok(f.objects.has(result.rawR2Key));
});

test("the actual Worker forwards matching MIME and keeps the original, attachments and multiple labels",async(t)=>{
	const f=await fixture(t);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:verifiedTarget})))).status,200);
	f.DB.db.exec(`INSERT INTO routing_rules(id,user_id,domain_id,mailbox_id,scope,pattern,match_field,match_operator,match_value,label_ids,created_at) VALUES ('extra-label','owner','domain','box','mailbox','@example.test','recipient','ends_with','@example.test','["source"]',1)`);
	const raw=mime(),forwards=[],rejects=[];
	await app.worker.email({from:"bounce@example.org",to:"owner@example.test",raw:new Response(raw).body,rawSize:raw.byteLength,headers:new Headers({from:"Sender <sender@example.org>",to:"owner@example.test"}),forward:async(target,headers)=>forwards.push({target,marker:headers.get("X-Mailflare-Forwarded")}),setReject:reason=>rejects.push(reason)},f.env,{waitUntil:()=>{}});
	assert.deepEqual(forwards,[{target:verifiedTarget,marker:"1"}]);assert.deepEqual(rejects,[]);assert.equal(f.queued.length,1);
	assert.deepEqual(new Uint8Array(f.objects.get(f.queued[0].rawR2Key)),new Uint8Array(raw));
	await app.processInboundMessage(f.env,f.queued[0]);
	const message=f.DB.db.prepare("SELECT id,mailbox_id FROM messages WHERE raw_r2_key=?").get(f.queued[0].rawR2Key);
	assert.equal(message.mailbox_id,"box");
	assert.deepEqual(f.DB.db.prepare("SELECT folder_id FROM message_labels WHERE message_id=? ORDER BY folder_id").all(message.id).map(x=>x.folder_id),["source","work"]);
	assert.equal(f.DB.db.prepare("SELECT filename FROM message_attachments WHERE message_id=?").get(message.id).filename,"note.txt");
	assert.equal(f.DB.db.prepare("SELECT match_count FROM routing_rules WHERE action='forward'").get().match_count,1);
});

test("unmatched mail, marked forwarded mail and failed forwarding all retain their local copy",async(t)=>{
	const f=await fixture(t);
	assert.equal((await app.createRule(f.request("POST",input({forwardTo:verifiedTarget})))).status,200);
	let forwards=0;
	for(const [sender,headers,fail] of [["other@example.org",{},false],["sender@example.org",{"x-mailflare-forwarded":"1"},false],["sender@example.org",{},true]]){
		const result=await app.intakeIncomingMail(f.env,{from:sender,to:"owner@example.test",raw:mime("owner@example.test",sender),headers},{forward:async()=>{forwards++;if(fail)throw new Error("Forwarding temporarily failed");return true;}});
		assert.equal(result.action,"store");assert.ok(f.objects.has(result.rawR2Key));
	}
	assert.equal(forwards,1);assert.equal(f.queued.length,3);
});

test("backup and restore retain mailbox forwarding rules without new schema",async(t)=>{
	const f=await fixture(t);
	const response=await app.createRule(f.request("POST",input({forwardTo:verifiedTarget})));assert.equal(response.status,200);
	const backup=await app.exportDatabaseRecords(f.env.DB);
	await app.restoreDatabaseRecords(f.env.DB,backup.buffer);
	const rule=f.DB.db.prepare("SELECT action,forward_to,keep_copy,label_ids FROM routing_rules").get();
	assert.equal(rule.action,"forward");assert.equal(rule.forward_to,verifiedTarget);assert.equal(rule.keep_copy,1);assert.equal(rule.label_ids,'["work"]');
});


test("a label created inside the filter flow is immediately accepted as a new rule target",async t=>{
 const f=await fixture(t);
 const labelResponse=await app.createLabel(f.request("POST",{mailboxId:"box",name:"Supplier invoices",parentId:"work"},"owner","/api/folders"));
 assert.equal(labelResponse.status,200);const label=await labelResponse.json();assert.equal(label.parentId,"work");
 const created=await app.createRule(f.request("POST",input({labelIds:["work",label.id],skipInbox:true})));
 assert.equal(created.status,200);
 const result=await app.resolveInboxRuleDestination(f.db,{mailboxId:"box",toAddress:"owner@example.test",fromAddress:"Sender <sender@example.org>",subject:"Information"});
 assert.deepEqual(new Set(result.labelIds),new Set(["work",label.id]));assert.equal(result.status,"archived");
 assert.equal(f.DB.db.prepare("SELECT count(*) n FROM messages").get().n,3);
});


test("recipient filters match each original recipient of forwarded Gmail and Googlemail messages",async t=>{
 const f=await fixture(t);
 const conditions=[{field:"recipient",operator:"exact",value:"personal@gmail.com",negate:false},{field:"recipient",operator:"exact",value:"personal@googlemail.com",negate:false}];
 assert.equal((await app.createRule(f.request("POST",input({conditions,conditionMode:"any",matchField:"recipient",matchValue:"personal@gmail.com"})))).status,200);
 for(const recipient of ['"Other, Person" <other@example.org>, Personal <PERSONAL@GMAIL.COM>','personal@googlemail.com']) {
  const result=await app.intakeIncomingMail(f.env,{from:"sender@example.org",to:"owner@example.test",raw:mime(recipient),headers:{}},{forward:async()=>true});
  await app.processInboundMessage(f.env,f.queued.at(-1));
  const message=f.DB.db.prepare("SELECT id,to_addr FROM messages WHERE raw_r2_key=?").get(result.rawR2Key);
  assert.match(message.to_addr,/personal@(?:gmail|googlemail)\.com/i);
  assert.deepEqual(f.DB.db.prepare("SELECT folder_id FROM message_labels WHERE message_id=?").all(message.id).map(x=>x.folder_id),["work"]);
 }
 const rule={pattern:"personal@gmail.com",matchField:"recipient",matchOperator:"exact"};
 assert.equal(app.matchesRule(rule,{toAddress:'"Other, Person" <other@example.org>; Personal <PERSONAL@GMAIL.COM>'}),true);
 assert.equal(app.matchesRule(rule,{toAddress:"other@gmail.com",fromAddress:"personal@gmail.com"}),false);
 assert.equal(app.matchesRule({...rule,conditions:JSON.stringify(conditions),conditionMode:"all"},{toAddress:"personal@gmail.com"}),false);
 assert.equal(app.matchesRule({...rule,conditions:JSON.stringify([{...conditions[0],negate:true}])},{toAddress:"personal@gmail.com, other@example.org"}),false);
});

test("content filters compare one readable body in live, forwarding and historical processing",()=>{
 const rule={pattern:"Your receipt & payment",matchField:"content",matchOperator:"exact"};
 assert.equal(app.matchesRule(rule,{toAddress:"owner@example.test",content:app.ruleMessageContent("Your receipt & payment",'<p>Your receipt &amp; payment</p>',"Your receipt & payment")}),true);
 assert.equal(app.matchesRule(rule,{toAddress:"owner@example.test",content:app.ruleMessageContent(null,'<head><style>unrelated</style></head><p>Your receipt &amp; <b>payment</b></p>')}),true);
 assert.equal(app.matchesRule({...rule,pattern:"unrelated",matchOperator:"contains"},{toAddress:"owner@example.test",content:app.ruleMessageContent(null,'<style>unrelated</style><p>Other text</p>')}),false);
});
