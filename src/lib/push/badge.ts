import { and, count, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { listAccessibleMailboxIds } from "@/lib/mailboxes/access";

/** Relevant unread inbox mail, excluding spam, trash and snoozed mail. */
export async function getUnreadBadgeCount(db: AppDatabase, user: SessionUser): Promise<number> {
	const mailboxIds = await listAccessibleMailboxIds(db, user);
	if (mailboxIds.length === 0) return 0;
	const [row] = await db.select({ unread: count() }).from(messages).where(and(
		inArray(messages.mailboxId, mailboxIds),
		eq(messages.direction, "inbound"),
		eq(messages.status, "received"),
		eq(messages.read, false),
		inArray(messages.category, ["primary", "invoices", "orders"]),
		isNull(messages.folderId),
		or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date())),
	));
	return row?.unread ?? 0;
}
