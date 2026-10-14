import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { buildReadableSnippet, needsSnippetRepair } from "@/lib/email/snippet";

/** One-time repair of poor legacy previews on the visible page, with bounded body prefixes. */
export async function repairVisiblePreviews(db: AppDatabase, rows: Array<{ id: string; snippet: string | null }>) {
	const candidates = rows.filter(row => needsSnippetRepair(row.snippet)).slice(0, 25);
	const repaired = new Map<string, string>();
	if (!candidates.length) return repaired;
	const bodies = await db.select({ id: messages.id, userId: messages.userId, snippet: messages.snippet,
		text: sql<string | null>`substr(${messages.textBody}, 1, 16384)`,
		html: sql<string | null>`substr(${messages.htmlBody}, 1, 65536)`,
	}).from(messages).where(inArray(messages.id, candidates.map(row => row.id)));
	const updates = bodies.flatMap(row => {
		const snippet = buildReadableSnippet(row.text, row.html);
		if (snippet === row.snippet) return [];
		repaired.set(row.id, snippet);
		return [db.update(messages).set({ snippet }).where(and(eq(messages.id, row.id), eq(messages.userId, row.userId),
			row.snippet === null ? sql`${messages.snippet} is null` : eq(messages.snippet, row.snippet)))];
	});
	if (updates.length) await db.batch(updates as [typeof updates[number], ...typeof updates[number][]]);
	return repaired;
}
