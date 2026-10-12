import { and, count, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { getMessageFolderParams } from "@/lib/messages/folder-params";
import { messageListFilterConditions } from "@/lib/messages/list-filter";
import { getRequestTimeZone } from "@/lib/time/utils";

// Keep each invocation and response small, even for imported archives.
const READ_ALL_BATCH_SIZE = 200;
const schema = z.object({
	folder: z.enum(["inbox", "promotions", "social", "invoices", "orders", "starred", "all", "snoozed", "sent", "scheduled", "drafts", "archived", "trash", "spam"]),
	mailboxId: z.string().min(1).max(200).optional(),
	folderId: z.string().min(1).max(200).optional(),
	q: z.string().max(4096).optional(),
	read: z.enum(["read", "unread"]).optional(),
	timeZone: z.string().max(100).optional(),
	after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	snapshot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	actorId: z.string().min(1).max(200).optional(),
	mailboxIds: z.array(z.string().min(1).max(200)).max(500).optional(),
}).strict().refine(value => value.snapshot === undefined || (!!value.actorId && !!value.mailboxIds), "Continuation scope required");

/** One idempotent chunk. The client schedules further chunks without blocking navigation. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const payload = schema.safeParse(await readJsonBody(request, 16384).catch(() => null));
	if (!payload.success) return NextResponse.json({ error: "Invalid read-all scope" }, { status: 400 });
	const input = payload.data;
	if (input.actorId && input.actorId !== user.id) return NextResponse.json({ error: "Session changed" }, { status: 409 });
	const db = getDb(env);
	const accessible = (await listAccessibleMailboxes(db, user)).map(mailbox => mailbox.id);
	if (input.mailboxId && !accessible.includes(input.mailboxId)) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	// Recheck grants on every chunk; never inherit access from an earlier request.
	const mailboxIds = input.mailboxId ? [input.mailboxId] : input.mailboxIds ? accessible.filter(id => input.mailboxIds!.includes(id)) : accessible;
	const params = getMessageFolderParams(input.folder, input.mailboxId, input.folderId);
	if (input.q) params.set("q", input.q);
	if (input.read) params.set("read", input.read);
	if (input.timeZone) params.set("timeZone", input.timeZone);
	const [boundary] = input.snapshot === undefined ? await db.select({ value: sql<number>`coalesce(max(rowid), 0)` }).from(messages) : [];
	const snapshot = input.snapshot ?? boundary?.value ?? 0;
	const scope = and(
		mailboxIds.length ? inArray(messages.mailboxId, mailboxIds) : sql`0`,
		...messageListFilterConditions(db, params, getRequestTimeZone(new Request(`${request.url}?${params}`), user.timeZone)),
		eq(messages.read, false),
		sql`rowid <= ${snapshot}`,
		sql`rowid > ${input.after ?? 0}`,
	);
	const [initial] = input.snapshot === undefined ? await db.select({ value: count() }).from(messages).where(scope) : [];
	// A bounded SQL subquery updates atomically. No mail bodies or archive-wide ID list.
	// Walk the row-ID range directly; date-sorted folder indexes would re-sort all remaining rows on every chunk.
	const batch = sql`(select ${messages.id} from ${messages} not indexed where ${scope} order by rowid limit ${READ_ALL_BATCH_SIZE})`;
	const changed = await db.update(messages).set({ read: true }).where(and(scope, inArray(messages.id, batch))).returning({ id: messages.id, rowId: sql<number>`rowid` });
	if (input.snapshot === undefined) await createAuditLog(env, { actorUserId: user.id, mailboxId: input.mailboxId, action: "message.read_all", metadata: { folder: input.folder, folderId: input.folderId, snapshot, matchedUnread: initial?.value ?? 0 } });
	return NextResponse.json({ messageIds: changed.map(row => row.id), done: changed.length < READ_ALL_BATCH_SIZE, total: initial?.value, snapshot, after: Math.max(input.after ?? 0, ...changed.map(row => row.rowId)), actorId: user.id, mailboxIds });
}
