import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { routingRules } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { captureRuleApplication, hasHistoricalRuleActions } from "@/lib/messages/apply-rule";
import { createBulkJob } from "@/lib/messages/bulk-jobs";

const schema = z.object({ requestId: z.string().min(1).max(200), includeSpamTrash: z.boolean().default(false) }).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv(), { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const input = schema.safeParse(await readJsonBody(request, 4096).catch(() => null));
	if (!input.success) return NextResponse.json({ error: "Invalid rule application" }, { status: 400 });
	const { id } = await params, db = getDb(env);
	const [rule] = await db.select().from(routingRules).where(eq(routingRules.id, id)).limit(1);
	if (rule?.scope !== "mailbox" || !rule.mailboxId || !(await getMailboxAccessLevel(db, user, rule.mailboxId))?.canManage) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
	if (!["store", "forward", "spam", "trash"].includes(rule.action)) return NextResponse.json({ error: "rule_no_historical_actions" }, { status: 400 });
	const captured = captureRuleApplication(rule, input.data.includeSpamTrash);
	if (!hasHistoricalRuleActions(captured)) return NextResponse.json({ error: "rule_no_historical_actions" }, { status: 400 });
	const title = (rule.matchValue || rule.pattern).slice(0, 180);
	const job = await createBulkJob(env, user, { folder: "all", mailboxId: rule.mailboxId, action: "applyRule", after: 0, ruleApplication: captured },
		{ folder: "all", mailboxId: rule.mailboxId, query: "", unreadOnly: false, title }, input.data.requestId);
	return job instanceof Response ? job : NextResponse.json({ job }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}
