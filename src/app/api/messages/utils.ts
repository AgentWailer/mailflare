import { and, countDistinct, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { messages } from "@/db/schema";
import type { SQL } from "drizzle-orm";
import type { ConversationPage, ConversationPageInput, ListMessage, MessageListColumns } from "./types";

export function getMessageListColumns(): MessageListColumns {
	return Object.fromEntries(
		Object.entries(getTableColumns(messages)).filter(([name]) => name !== "textBody" && name !== "htmlBody" && name !== "headerMetadata"),
	) as MessageListColumns;
}

/** Select one newest matching message per thread before applying pagination. */
export async function loadConversationPage({ db, where, offset, limit, metadataOnlyScan = false }: ConversationPageInput): Promise<ConversationPage> {
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;
	// The ordered conversation index lacks starred. SQLite otherwise reads every
	// large message row to count stars. Keep this scan inside the existing metadata index.
	const source = metadataOnlyScan ? sql`${messages} indexed by messages_counts_cover_idx` : messages;
	const ranked = db
		.select({
			id: sql<string>`${messages.id}`.as("id"),
			createdAt: sql`${messages.createdAt}`.mapWith(messages.createdAt).as("created_at"),
			position: sql<number>`row_number() over (partition by ${threadKey} order by ${messages.createdAt} desc, ${messages.id} desc)`.as("position"),
		})
		.from(source)
		.where(where)
		.as("conversation_heads");

	// Always two queries, even for deep pages or threads with many messages.
	const [totals, heads] = await db.batch([
		db.select({ total: countDistinct(threadKey) }).from(source).where(where),
		db
			.select({ id: ranked.id })
			.from(ranked)
			.where(eq(ranked.position, 1))
			.orderBy(desc(ranked.createdAt), desc(ranked.id))
			.limit(limit)
			.offset(offset),
	]);

	return { ids: heads.map((head) => head.id), total: totals[0]?.total ?? 0 };
}

/** Fetch only already-paginated IDs, while retaining every permission/filter predicate. */
export async function loadConversationRows({ db, where, ids }: Pick<ConversationPageInput, "db" | "where"> & { ids: string[] }) {
	if (!ids.length) return [];
	// This is a required bounded access path: the planner otherwise favors the
	// mailbox/read index and reads ~69k large rows just to return 25 selected IDs.
	// The index is SQLite's primary-key index for messages.id (TEXT PRIMARY KEY).
	// SQL FROM expressions need SQL projections; mapWith preserves Date/boolean decoding.
	const columns = Object.fromEntries(Object.entries(getMessageListColumns()).map(([key, column]) =>
		[key, sql`${column}`.mapWith(column)])) as { [K in keyof MessageListColumns]: SQL<ListMessage[K]> };
	return db.select(columns)
		.from(sql`${messages} indexed by sqlite_autoindex_messages_1`)
		.where(and(where, inArray(messages.id, ids)));
}
