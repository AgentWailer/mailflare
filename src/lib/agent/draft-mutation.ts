import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentDraftMetadata, messageAttachments, messages } from "@/db/schema";
import type { StoredAttachment } from "@/lib/email/attachment-types";

export const DRAFT_CHANGED_ERROR = "Draft changed or sending is in progress; reopen it before editing";

/** This predicate stays true for every statement until the final revision update. */
export function editableAgentRevision(draftId: string, revision: number) {
	return sql`exists (select 1 from agent_draft_metadata adm join messages m on m.id=adm.draft_id
		where adm.draft_id=${draftId} and adm.revision=${revision} and m.status='draft')
		and not exists (select 1 from agent_send_approvals where draft_id=${draftId} and status in ('claimed','sent','unknown'))`;
}

/** Publish fields, staged files and revision together. No R2 I/O occurs inside this batch. */
export async function commitAgentDraftMutation(env: CloudflareEnv, input: {
	draftId: string; revision: number;
	patch?: Partial<typeof messages.$inferInsert>;
	added?: StoredAttachment[]; removeIds?: string[]; trashIds?: string[]; restoreIds?: string[];
	human?: boolean; scheduledAt?: Date | null;
}) {
	const db = getDb(env), guard = editableAgentRevision(input.draftId, input.revision);
	const prepared = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
		const value = query.toSQL();
		return env.DB.prepare(value.sql).bind(...value.params);
	};
	const statements: D1PreparedStatement[] = [];
	if (input.patch) statements.push(prepared(db.update(messages).set(input.patch).where(and(eq(messages.id, input.draftId), guard))));
	// Drizzle's select renders/encodes the guard once for raw INSERT ... SELECT.
	const condition = db.select({ allowed: sql<number>`1` }).from(agentDraftMetadata).where(and(eq(agentDraftMetadata.draftId, input.draftId), guard)).toSQL();
	for (const file of input.added ?? []) {
		statements.push(env.DB.prepare(`INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at)
			SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (${condition.sql})`).bind(file.id, input.draftId, file.filename, file.type, file.size, file.disposition, file.contentId, file.r2Key, Math.floor(Date.now() / 1000), ...condition.params));
	}
	for (const id of input.removeIds ?? []) {
		statements.push(env.DB.prepare(`DELETE FROM message_attachments WHERE message_id=? AND id=? AND EXISTS (${condition.sql})`).bind(input.draftId, id, ...condition.params));
	}
	for (const [ids, trashedAt] of [[input.trashIds, Math.floor(Date.now() / 1000)], [input.restoreIds, null]] as const) {
		for (const id of ids ?? []) statements.push(env.DB.prepare(`UPDATE message_attachments SET trashed_at=?
			WHERE message_id=? AND id=? AND EXISTS (${condition.sql})`).bind(trashedAt, input.draftId, id, ...condition.params));
	}
	statements.push(prepared(db.update(agentDraftMetadata).set({
		revision: input.revision + 1,
		...(input.human ? { humanEditedAt: new Date() } : {}),
		...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
	}).where(and(eq(agentDraftMetadata.draftId, input.draftId), guard)).returning({ revision: agentDraftMetadata.revision })));
	const result = await env.DB.batch<{ revision: number }>(statements);
	const revision = result.at(-1)?.results[0]?.revision;
	if (!revision) throw new Error(DRAFT_CHANGED_ERROR);
	return revision;
}

/** Delete atomically before cleaning objects, so a send claim cannot lose its files. */
export async function discardAgentDraft(env: CloudflareEnv, draftId: string, revision: number, rawR2Key: string | null) {
	const db = getDb(env);
	const files = await db.select({ key: messageAttachments.r2Key }).from(messageAttachments).where(eq(messageAttachments.messageId, draftId));
	const removed = await db.delete(messages).where(and(eq(messages.id, draftId), editableAgentRevision(draftId, revision))).returning({ id: messages.id });
	if (!removed.length) throw new Error(DRAFT_CHANGED_ERROR);
	await Promise.allSettled([...files.map(file => file.key), ...(rawR2Key ? [rawR2Key] : [])].map(key => env.BUCKET.delete(key)));
}
