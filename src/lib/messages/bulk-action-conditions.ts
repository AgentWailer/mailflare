import { eq, inArray, ne, type SQL } from "drizzle-orm";
import { messages } from "@/db/schema";

/** Shared by preview, queue candidates and the final update (including saved retries). */
export function bulkActionConditions(action: string | undefined): SQL[] {
	if (action === "read" || action === "unread") return [eq(messages.read, action === "unread")];
	// Archiving removes ordinary messages from the inbox. Never resurrect spam/trash,
	// archive drafts, or rewrite an already archived message and its sync revision.
	if (action === "archive") return [inArray(messages.status, ["received", "sent"])];
	if (action === "trash" || action === "spam") return [ne(messages.status, action)];
	return [];
}
