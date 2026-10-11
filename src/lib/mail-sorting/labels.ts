import { and, eq, inArray, or, sql } from "drizzle-orm";
import { folders, messageLabels, messages } from "@/db/schema";
import type { AppDatabase } from "@/db";
export function labelCondition(folderId: string) {
	return or(
		eq(messages.folderId, folderId),
		sql`exists (select 1 from message_labels ml where ml.message_id = ${messages.id} and ml.folder_id = ${folderId})`,
	)!;
}
export async function getMessageLabels(db: AppDatabase, ids: string[]) {
	const rows: Array<{
		messageId: string;
		id: string;
		name: string;
		color: string;
	}> = [];
	for (let offset = 0; offset < ids.length; offset += 80)
		rows.push(
			...(await db
				.select({
					messageId: messageLabels.messageId,
					id: folders.id,
					name: folders.name,
					color: folders.color,
				})
				.from(messageLabels)
				.innerJoin(folders, eq(messageLabels.folderId, folders.id))
				.innerJoin(messages, eq(messageLabels.messageId, messages.id))
				.where(
					and(
						inArray(messageLabels.messageId, ids.slice(offset, offset + 80)),
						eq(folders.mailboxId, messages.mailboxId),
					),
				)),
		);
	return rows;
}
export async function validLabelIds(
	db: AppDatabase,
	mailboxId: string,
	ids: string[],
) {
	if (!ids.length) return [];
	return (
		await db
			.select({ id: folders.id })
			.from(folders)
			.where(and(eq(folders.mailboxId, mailboxId), inArray(folders.id, ids)))
	).map((x) => x.id);
}
