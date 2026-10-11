import { validLabelIds } from "@/lib/mail-sorting/labels";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { folders, routingRules } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { routingRuleSchema } from "@/lib/validators";
import { hasRuleSourceMessage } from "@/lib/email/mailbox-rule-validation";
import { RuleForwardingError, validateRuleForwardingTarget } from "@/lib/email/rule-forwarding";

export async function GET(request: Request) {
	const env = getEnv();
	const {user,error} = await requireSessionUser(env,request);
 if(error)return error;
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ rules: [] });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const rows = await db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.mailboxId, mailboxId), eq(routingRules.scope, "mailbox")));
	return NextResponse.json({ rules: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const {user,error} = await requireSessionUser(env,request);
 if(error)return error;
	if(!hasValidSessionMutationOrigin(request)) return NextResponse.json({error:"Invalid origin"},{status:403});
	const parsed = routingRuleSchema.safeParse(await request.json().catch(()=>null));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const mailbox = access.mailbox;
	if (!(await hasRuleSourceMessage(db, mailbox.id, parsed.data.sourceMessageId))) return NextResponse.json({error:"Source message not found"},{status:404});

	const destination = parsed.data.destination ?? (parsed.data.folderId ? `folder:${parsed.data.folderId}` : "");
	const systemAction = destination === "spam" || destination === "trash" ? destination : null;
	const folderId = destination.startsWith("folder:") ? destination.slice("folder:".length) : null;
	if (parsed.data.forwardTo) {
		if (systemAction) return NextResponse.json({error:"forwarding_status_conflict"},{status:400});
		try { if (parsed.data.enabled) await validateRuleForwardingTarget(env, db, mailbox, parsed.data.forwardTo); }
		catch (error) { return NextResponse.json({error:error instanceof RuleForwardingError ? error.code : "forwarding_unavailable"},{status:error instanceof RuleForwardingError && error.code !== "forwarding_unavailable" ? 400 : 503}); }
	}
	if (parsed.data.action === "forward" && !parsed.data.forwardTo) return NextResponse.json({error:"forwarding_unverified"},{status:400});

	if (!systemAction && !folderId && destination !== "keep" && !parsed.data.category && !parsed.data.labelIds.length && !parsed.data.skipInbox && !parsed.data.forwardTo) {
		return NextResponse.json({ error: "Destination is required" }, { status: 400 });
	}

	if (folderId) {
		const [folder] = await db
			.select()
			.from(folders)
			.where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailbox.id)))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
	}

	const labelIds = [...new Set(parsed.data.labelIds)];
 if((await validLabelIds(db, parsed.data.mailboxId,labelIds)).length!==labelIds.length) return NextResponse.json({error:"Label not found"},{status:404});
	const id = newId("rule");
	await db.insert(routingRules).values({
		id,
		userId: user.id,
		domainId: mailbox.domainId,
		scope: "mailbox",
		pattern: parsed.data.matchValue.trim(),
		matchField: parsed.data.matchField,
		matchOperator: parsed.data.matchOperator,
		matchValue: parsed.data.matchValue.trim(),
		action: parsed.data.forwardTo ? "forward" : systemAction ?? "store",
		mailboxId: mailbox.id,
		folderId,
		forwardTo: parsed.data.forwardTo ?? null,
		keepCopy: !!parsed.data.forwardTo,
		priority: parsed.data.priority,
 enabled:parsed.data.enabled,
 conditions:JSON.stringify(parsed.data.conditions),conditionMode:parsed.data.conditionMode,
 labelIds:JSON.stringify(labelIds),category:parsed.data.category??null,skipInbox:parsed.data.skipInbox,
	});

	return NextResponse.json({ id, ...parsed.data });
}
