import { and, count, eq, notInArray, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders, messageLabels, messages } from "@/db/schema";

/** Keep the join order bounded by messages + assigned labels, not folders × messages.
 * SQLite otherwise starts from every folder and rescans the entire mailbox for each.
 * CROSS JOIN preserves these indexed lookups even before planner statistics exist.
 */
export function labelCountsQuery(db: AppDatabase, conditions: SQL[]) {
	return db.select({
		id: messageLabels.folderId,
		total: count(),
		unread: sql<number>`sum(case when ${messages.direction}='inbound' and ${messages.read}=0 then 1 else 0 end)`,
	}).from(sql`${messages} indexed by messages_counts_cover_idx`)
		.crossJoin(messageLabels).crossJoin(folders)
		.where(and(...conditions, eq(messageLabels.messageId, messages.id), eq(folders.id, messageLabels.folderId),
			eq(folders.mailboxId, messages.mailboxId), notInArray(messages.status, ["spam", "trash", "template"])))
		.groupBy(messageLabels.folderId);
}
