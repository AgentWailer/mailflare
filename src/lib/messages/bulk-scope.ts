import { and, count, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { messages, folders } from "@/db/schema";
import { listAccessibleMailboxes, getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getMessageFolderParams } from "@/lib/messages/folder-params";
import { messageListFilterConditions } from "@/lib/messages/list-filter";
import { executeBulkMessageAction } from "@/lib/messages/bulk-action";
import { executeOrganizationAction } from "@/lib/messages/organize-action";
import { applyRuleToMessages, hasHistoricalRuleActions, ruleApplicationSchema, ruleNeedsContent } from "./apply-rule";
import { getRequestTimeZone } from "@/lib/time/utils";

export const bulkScopeSchema = z.object({
	folder: z.enum(["inbox", "promotions", "social", "invoices", "orders", "starred", "all", "snoozed", "sent", "scheduled", "drafts", "archived", "trash", "spam"]),
	mailboxId: z.string().min(1).max(200).optional(),
	folderId: z.string().min(1).max(200).optional(),
	q: z.string().max(4096).optional(),
	read: z.enum(["read", "unread"]).optional(),
	timeZone: z.string().max(100).optional(),
	inboxPolicy: z.enum(["primary_only", "relevant"]).optional(),
	after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
	snapshot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	actorId: z.string().min(1).max(200).optional(),
	mailboxIds: z.array(z.string().min(1).max(200)).max(500).optional(),
	action: z.enum(["select", "archive", "trash", "spam", "read", "unread", "inbox", "folder", "delete", "organize", "applyRule"]),
	ruleApplication: ruleApplicationSchema.optional(),
	destinationFolderId: z.string().min(1).max(200).optional(),
	organization: z.object({
		addLabelIds: z.array(z.string().min(1)).max(50).optional(),
		removeLabelIds: z.array(z.string().min(1)).max(50).optional(),
		category: z.enum(["primary", "promotions", "social", "invoices", "orders"]).optional(),
		skipInbox: z.boolean().optional(),
	}).strict().optional(),
}).strict().refine(value => value.snapshot === undefined || (!!value.actorId && !!value.mailboxIds), "Continuation scope required");

export type BulkScopeInput = z.infer<typeof bulkScopeSchema>;
export type ScopeChunk = { messageIds: string[]; after: number; done: boolean };

/** Shared by HTTP chunks and durable queue jobs; every chunk checks current grants. */
export async function executeBulkScope(env: CloudflareEnv, user: import("@/lib/auth/types").SessionUser, input: BulkScopeInput, options: { preview?: boolean; pending?: ScopeChunk; beforeApply?: (chunk: ScopeChunk) => Promise<void> } = {}) {
	if (input.actorId && input.actorId !== user.id) return NextResponse.json({ error: "Session changed" }, { status: 409 });
	if (input.action === "delete" && (input.folderId || !["trash", "spam"].includes(input.folder))) return NextResponse.json({ error: "Permanent deletion requires Trash or Spam" }, { status: 400 });
	const db = getDb(env);
	const accessible = (await listAccessibleMailboxes(db, user)).map(mailbox => mailbox.id);
	if (input.mailboxId && !accessible.includes(input.mailboxId)) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	const mailboxIds = input.mailboxId ? [input.mailboxId] : input.mailboxIds ? input.mailboxIds : accessible;
	// Fail as a whole on revocation; do not silently broaden or partially apply a selection.
	if (mailboxIds.some(id => !accessible.includes(id))) return NextResponse.json({ error: "Mailbox access changed" }, { status: 404 });
	const grants = await Promise.all(mailboxIds.map(id => getMailboxAccessLevel(db, user, id)));
	const canManage = grants.every(access => access?.canManage);
	if (!["select", "read", "unread"].includes(input.action) && !canManage) return NextResponse.json({ error: "Mailbox access denied" }, { status: 404 });
	if (input.action === "applyRule" && (!input.ruleApplication || !hasHistoricalRuleActions(input.ruleApplication) || mailboxIds.length !== 1 || input.folder !== "all" || input.folderId || input.q || input.read)) return NextResponse.json({ error: "Invalid rule application" }, { status: 400 });
	if (input.action === "organize" && (!input.organization || mailboxIds.length !== 1)) return NextResponse.json({ error: "Organization requires one mailbox" }, { status: 400 });
	if (input.action === "folder") {
		const [destination] = input.destinationFolderId ? await db.select({ mailboxId: folders.mailboxId }).from(folders).where(eq(folders.id, input.destinationFolderId)).limit(1) : [];
		if (mailboxIds.length !== 1 || !destination || destination.mailboxId !== mailboxIds[0]) return NextResponse.json({ error: "Folder not found in selection mailbox" }, { status: 404 });
	}
	const params = getMessageFolderParams(input.folder, input.mailboxId, input.folderId);
	if (input.q) params.set("q", input.q);
	if (input.read) params.set("read", input.read);
	if (input.timeZone) params.set("timeZone", input.timeZone);
	if (input.inboxPolicy) params.set("inboxPolicy", input.inboxPolicy);
	const [boundary] = input.snapshot === undefined || options.preview ? await db.select({ value: sql<number>`coalesce(max(rowid), 0)` }).from(messages) : [];
	const snapshot = options.preview ? Math.min(input.snapshot ?? Number.MAX_SAFE_INTEGER, boundary?.value ?? 0) : input.snapshot ?? boundary?.value ?? 0;
	const scope = and(
		mailboxIds.length ? inArray(messages.mailboxId, mailboxIds) : sql`0`,
		...(input.action === "read" || input.action === "unread" ? [eq(messages.read, input.action === "unread")] : []),
		...(input.action === "applyRule" ? [inArray(messages.status, input.ruleApplication!.includeSpamTrash ? ["received", "archived", "spam", "trash"] : ["received", "archived"])] : []),
		...messageListFilterConditions(db, params, getRequestTimeZone(new Request(`https://mailflare.internal/?${params}`), user.timeZone)),
		sql`${messages}.rowid <= ${snapshot}`,
		sql`${messages}.rowid > ${input.after}`,
	);
	const context = { snapshot, actorId: user.id, mailboxIds, canManage, inboxPolicy: input.inboxPolicy ?? "relevant" };
	if (input.action === "select" || options.preview) {
		const [summary] = await db.select({ total: count(), unread: sql<number>`coalesce(sum(case when ${messages.read} = 0 then 1 else 0 end), 0)` }).from(messages).where(scope);
		return NextResponse.json({ ...context, after: 0, total: summary?.total ?? 0, unread: summary?.unread ?? 0 });
	}
	// Spam feedback trains token/reputation statistics; keep expensive training bounded per invocation.
	const trainsSpam = input.action === "spam" || input.action === "inbox" && ["spam", "all", "starred"].includes(input.folder);
	const batchSize = input.action === "applyRule" ? Math.min(ruleNeedsContent(input.ruleApplication!) ? 5 : 25, Math.max(1, Math.floor(80 / (input.ruleApplication!.labelIds.length + 1)))) : trainsSpam ? 1 : ["organize", "delete"].includes(input.action) ? 5 : 80;
	// Scan forward once; sorting the whole remaining archive on each chunk is unnecessary.
	const readAction = input.action === "read" || input.action === "unread";
	const accessPath = readAction ? sql`indexed by messages_mailbox_read_actions_idx` : sql`not indexed`;
	const candidates = options.pending ? [] : (await db.all<{ id: string; rowId: number }>(sql`select ${messages.id} as id, rowid as rowId from ${messages} ${accessPath} where ${scope} order by rowid limit ${batchSize}`));
	const chunk = options.pending ?? { messageIds: candidates.map(row => row.id), done: candidates.length < batchSize, after: Math.max(input.after, ...candidates.map(row => row.rowId)) };
	if (options.beforeApply) await options.beforeApply(chunk);
	// Retry a saved chunk even if the action changed its folder/read filter. Already
	// deleted messages are counted in the checkpoint but need no repeat action.
	const messageIds = options.pending ? (await db.select({ id: messages.id }).from(messages).where(and(inArray(messages.id, chunk.messageIds), inArray(messages.mailboxId, mailboxIds)))).map(row => row.id) : chunk.messageIds;
	if (messageIds.length) {
		const result = input.action === "applyRule"
			? await applyRuleToMessages(env, mailboxIds[0], messageIds, input.ruleApplication!)
			: input.action === "organize"
			? await executeOrganizationAction(env, user, { mailboxId: mailboxIds[0], messageIds, ...input.organization, rememberSender: false })
			: await executeBulkMessageAction(env, user, { messageIds, action: input.action, folderId: input.destinationFolderId });
		if (!result.ok) return result;
	}
	return NextResponse.json({ ...context, ...chunk });
}
