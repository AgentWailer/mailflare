import { requestTiming } from "@/lib/server-timing";
import { and, count, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { scheduledMessageCondition } from "@/lib/email/scheduled";
import { buildMessageCounts } from "./utils";
import { labelCountsQuery } from "./label-counts";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";

export async function GET(request: Request) {
	const timing = requestTiming();
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	timing.mark("auth");

	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const db = getDb(env);
	const conditions: SQL[] = [];

	if (mailboxId) {
		const access = await getMailboxAccessLevel(db, user, mailboxId);
		if (!access?.canRead) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		conditions.push(eq(messages.mailboxId, mailboxId));
	} else {
		const accessibleMailboxIds = await listAccessibleMailboxIds(db, user);
		if (accessibleMailboxIds.length > 0) {
			conditions.push(inArray(messages.mailboxId, accessibleMailboxIds));
		} else {
			conditions.push(eq(messages.userId, user.id));
		}
	}

	timing.mark("access");
	const rowsQuery = db
		.select({
			mailboxId: messages.mailboxId,
			folderId: messages.folderId,
			category: messages.category,
			direction: messages.direction,
			status: messages.status,
			read: messages.read,
			starred: messages.starred,
			snoozedUntil: messages.snoozedUntil,
			total: count(),
		})
		.from(messages)
		.where(and(...conditions))
		.groupBy(
			messages.mailboxId,
			messages.folderId,
			messages.category,
			messages.direction,
			messages.status,
			messages.read,
			messages.starred,
			messages.snoozedUntil,
		);

	const scheduledQuery = db
		.select({ total: count() })
		.from(messages)
		.where(and(...conditions, scheduledMessageCondition(db)));
	const labelsQuery = labelCountsQuery(db, conditions);
	// One D1 round trip and one consistent snapshot for the independent tallies.
	const [rows, [scheduledRow], labels] = await db.batch([rowsQuery, scheduledQuery, labelsQuery]);
	timing.mark("counts");
	const counts = buildMessageCounts(rows);
 counts.customFolders = Object.fromEntries(labels.map(label=>[label.id,{total:label.total,unread:label.unread}]));
	counts.folders.scheduled.total = scheduledRow?.total ?? 0;

	return NextResponse.json({ counts }, { headers: timing.headers() });
}
