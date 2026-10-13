import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { messages, routingRules } from "@/db/schema";
import { matchesRule } from "@/lib/email/routing";
import { validLabelIds } from "@/lib/mail-sorting/labels";

// Only the server captures these fields from a saved, authorized mailbox rule.
export const ruleApplicationSchema = z.object({
	id: z.string().min(1).max(200),
	pattern: z.string().max(4096),
	conditions: z.string().max(32768).nullable(),
	conditionMode: z.string().max(20).nullable(),
	matchField: z.string().max(30).nullable(),
	matchOperator: z.string().max(30).nullable(),
	matchValue: z.string().max(4096).nullable(),
	labelIds: z.array(z.string().min(1).max(200)).max(51),
	category: z.enum(["primary", "promotions", "social", "invoices", "orders"]).nullable(),
	action: z.enum(["store", "forward", "spam", "trash"]),
	folderId: z.string().min(1).max(200).nullable(),
	skipInbox: z.boolean(),
	includeSpamTrash: z.boolean().default(false),
}).strict();
export type RuleApplication = z.infer<typeof ruleApplicationSchema>;

export function captureRuleApplication(rule: typeof routingRules.$inferSelect, includeSpamTrash: boolean): RuleApplication {
	let labels: string[] = [];
	try { const value = JSON.parse(rule.labelIds); if (Array.isArray(value)) labels = value.filter((id): id is string => typeof id === "string"); } catch { /* Legacy rule. */ }
	return ruleApplicationSchema.parse({
		id: rule.id, pattern: rule.pattern, conditions: rule.conditions,
		conditionMode: rule.conditionMode, matchField: rule.matchField,
		matchOperator: rule.matchOperator, matchValue: rule.matchValue,
		labelIds: [...new Set([...labels, ...(rule.folderId ? [rule.folderId] : [])])],
		category: rule.category, action: rule.action, folderId: rule.folderId,
		skipInbox: rule.skipInbox, includeSpamTrash,
	});
}

export function hasHistoricalRuleActions(rule: Pick<RuleApplication, "labelIds" | "category" | "action" | "folderId" | "skipInbox">): boolean {
	return !!(rule.labelIds.length || rule.category || rule.folderId || rule.skipInbox || rule.action === "spam" || rule.action === "trash");
}

export function ruleNeedsContent(rule: Pick<RuleApplication, "matchField" | "conditions">): boolean {
	if (rule.conditions) {
		try {
			const conditions = JSON.parse(rule.conditions);
			if (Array.isArray(conditions) && conditions.length) return conditions.some(condition => condition?.field === "content");
		} catch { return false; }
	}
	return rule.matchField === "content";
}

/** Additive, idempotent local actions; never re-send historical mail or generate alerts. */
export async function applyRuleToMessages(env: CloudflareEnv, mailboxId: string, ids: string[], rule: RuleApplication) {
	const db = getDb(env);
	if ((await validLabelIds(db, mailboxId, rule.labelIds)).length !== rule.labelIds.length) return new Response(JSON.stringify({ error: "Rule label no longer exists" }), { status: 409 });
	const needsBody = ruleNeedsContent(rule);
	// Sender/subject filters need no potentially large imported message bodies.
	const rows = await db.select({
		id: messages.id, direction: messages.direction, status: messages.status,
		fromAddr: messages.fromAddr, toAddr: messages.toAddr, subject: messages.subject,
		category: messages.category, folderId: messages.folderId, sortingDecision: messages.sortingDecision,
		textBody: needsBody ? messages.textBody : sql<string | null>`null`,
		htmlBody: needsBody ? messages.htmlBody : sql<string | null>`null`,
		snippet: needsBody ? messages.snippet : sql<string | null>`null`,
	}).from(messages).where(and(eq(messages.mailboxId, mailboxId), inArray(messages.id, ids)));
	const statements: D1PreparedStatement[] = [];
	for (const row of rows) {
		if (row.direction !== "inbound" || !["received", "archived", ...(rule.includeSpamTrash ? ["spam", "trash"] : [])].includes(row.status)) continue;
		if (!matchesRule(rule, { toAddress: row.toAddr, fromAddress: row.fromAddr, subject: row.subject, content: [row.textBody, row.htmlBody, row.snippet].filter(Boolean).join(" ") })) continue;
		for (const labelId of rule.labelIds) statements.push(env.DB.prepare("INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES (?,?)").bind(row.id, labelId));
		const status = rule.action === "spam" || rule.action === "trash" ? rule.action : rule.skipInbox && row.status === "received" ? "archived" : row.status;
		const folderId = rule.action === "spam" || rule.action === "trash" ? null : rule.folderId && status === "received" ? rule.folderId : row.folderId;
		statements.push(env.DB.prepare("UPDATE messages SET category=?, status=?, folder_id=?, sorting_decision=? WHERE id=? AND mailbox_id=?")
			.bind(rule.category ?? row.category, status, folderId, rule.category ? JSON.stringify({ category: rule.category, source: "rule", reason: "existing_mail_filter", ruleId: rule.id }) : row.sortingDecision, row.id, mailboxId));
	}
	// Keep even rules with many labels within a small atomic D1 batch.
	if (statements.length) await env.DB.batch(statements);
	return Response.json({ ok: true });
}
