import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { getMessageListColumns } from "@/app/api/messages/utils";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import { cleanSnippetText, needsSnippetRepair } from "@/lib/email/snippet";
import { getMessageLabels } from "@/lib/mail-sorting/labels";
import { hasMailboxPermission, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { getListAttachmentCounts } from "@/lib/messages/list-attachments";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import type { SessionUser } from "@/lib/auth/types";
import { decodeCursor, encodeCursor } from "./cursor-utils";
import type { AppSyncCursor, AppSyncMessage, AppSyncOptions, AppSyncResponse } from "./sync-types";

const selectListRows = (db: AppDatabase) => db.select(getMessageListColumns()).from(messages);
type ListRow = Awaited<ReturnType<typeof selectListRows>>[number];
type ReadableMailbox = Awaited<ReturnType<typeof listAccessibleMailboxes>>[number];

const ID_CHUNK = 80;

/** One bound parameter however many mailboxes there are; D1 allows 100 per statement. */
function inMailboxes(ids: string[]) {
	return sql`${messages.mailboxId} in (select value from json_each(${JSON.stringify(ids)}))`;
}

async function loadRows(db: AppDatabase, ids: string[], mailboxIds: string[]): Promise<ListRow[]> {
	const rows: ListRow[] = [];
	for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
		rows.push(...(await selectListRows(db)
			.where(and(inArray(messages.id, ids.slice(offset, offset + ID_CHUNK)), inMailboxes(mailboxIds)))));
	}
	return rows;
}

async function enrich(env: CloudflareEnv, db: AppDatabase, user: SessionUser, mailboxes: ReadableMailbox[], rows: ListRow[]): Promise<AppSyncMessage[]> {
	if (rows.length === 0) return [];
	const owners = Array.from(new Set(rows.map((row) => row.userId)));
	const [labels, attachmentCounts, contactEntries] = await Promise.all([
		getMessageLabels(db, rows.map((row) => row.id)),
		getListAttachmentCounts(db, rows, false, undefined),
		Promise.all(owners.map(async (userId) => {
			const addresses = rows.filter((row) => row.userId === userId).flatMap((row) => [row.fromAddr, getFirstEmailAddressEntry(row.toAddr)]);
			return [userId, await getContactDisplayNameMap(env, userId, addresses)] as const;
		})),
	]);
	const namesByOwner = new Map(contactEntries);
	const labelsById = new Map<string, AppSyncMessage["labels"]>();
	for (const { messageId, ...label } of labels) {
		const assigned = labelsById.get(messageId) ?? [];
		assigned.push(label);
		labelsById.set(messageId, assigned);
	}
	const accountNames = new Map(mailboxes.map((mailbox) => [
		mailbox.id,
		mailbox.userId === user.id && tracksAccountIdentity(mailbox, user.email) ? user.name : mailbox.displayName ?? mailbox.localPart,
	]));
	return rows.map(({ rawR2Key, ...message }) => {
		// Storage keys never leave the server.
		void rawR2Key;
		const names = namesByOwner.get(message.userId);
		const accountName = message.mailboxId ? accountNames.get(message.mailboxId) : null;
		return {
			...message,
			snippet: needsSnippetRepair(message.snippet) ? cleanSnippetText(message.snippet) : message.snippet,
			attachmentCount: attachmentCounts.get(message.id) ?? 0,
			labels: labelsById.get(message.id) ?? [],
			fromContactName: (message.direction === "outbound" ? accountName : null) ?? names?.get(normalizeEmailAddress(message.fromAddr)) ?? null,
			toContactName: names?.get(normalizeEmailAddress(getFirstEmailAddressEntry(message.toAddr))) ?? null,
		};
	});
}

/** The highest sequence number ever given out and the lowest one still stored. */
async function logBounds(env: CloudflareEnv): Promise<{ top: number; floor: number | null }> {
	const row = await env.DB.prepare(
		"SELECT (SELECT seq FROM sqlite_sequence WHERE name = 'mail_changes') AS top, (SELECT min(seq) FROM mail_changes) AS floor",
	).first<{ top: number | null; floor: number | null }>();
	return { top: row?.top ?? 0, floor: row?.floor ?? null };
}

/**
 * A cursor fits when every change after it is still in the log. It does not when the log was
 * pruned past it, or when the log restarted below it (a restored database).
 */
function cursorFitsLog(cursor: AppSyncCursor, bounds: { top: number; floor: number | null }): boolean {
	if (cursor.seq > bounds.top) return false;
	if (bounds.floor === null) return cursor.seq === bounds.top;
	return cursor.seq >= bounds.floor - 1;
}

export async function syncForDevice(env: CloudflareEnv, user: SessionUser, options: AppSyncOptions): Promise<AppSyncResponse> {
	const db = getDb(env);
	const mailboxes = (await listAccessibleMailboxes(db, user)).filter((mailbox) => hasMailboxPermission(mailbox.permission, "read_only"));
	const mailboxIds = mailboxes.map((mailbox) => mailbox.id);
	const bounds = await logBounds(env);
	const reset: AppSyncResponse = { cursor: "", more: false, reset: true, mailboxIds, messages: [], removed: [] };

	let cursor: AppSyncCursor;
	if (options.cursor === null) {
		// Changes from here on are replayed after the window has been paged through.
		cursor = { v: 1, seq: bounds.top, days: options.days, backfill: { createdAt: Number.MAX_SAFE_INTEGER, id: "" } };
	} else {
		const decoded = decodeCursor(options.cursor);
		if (!decoded || decoded.days !== options.days || !cursorFitsLog(decoded, bounds)) return reset;
		cursor = decoded;
	}

	if (cursor.backfill) {
		const now = options.now ?? new Date();
		const windowStart = new Date(now.getTime() - cursor.days * 86_400_000);
		const position = cursor.backfill;
		const first = position.createdAt === Number.MAX_SAFE_INTEGER;
		const before = new Date(position.createdAt * 1000);
		const rows: ListRow[] = mailboxIds.length === 0 ? [] : await selectListRows(db)
			.where(and(
				inMailboxes(mailboxIds),
				gte(messages.createdAt, windowStart),
				first ? undefined : or(lt(messages.createdAt, before), and(eq(messages.createdAt, before), lt(messages.id, position.id))),
			))
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(options.limit);
		const last = rows.at(-1);
		const done = rows.length < options.limit || !last;
		const next: AppSyncCursor = { ...cursor, backfill: done ? null : { createdAt: Math.floor(last.createdAt.getTime() / 1000), id: last.id } };
		// Always come back once more: what changed while the window was paged is next.
		return { cursor: encodeCursor(next), more: true, reset: false, mailboxIds, messages: await enrich(env, db, user, mailboxes, rows), removed: [] };
	}

	// Read the log unfiltered and sort out readable mailboxes here, so the cursor always
	// advances past other people's changes. Stop at the page size of distinct messages.
	const scanned = await env.DB.prepare("SELECT seq, mailbox_id, message_id FROM mail_changes WHERE seq > ? ORDER BY seq LIMIT ?")
		.bind(cursor.seq, options.limit * 4).all<{ seq: number; mailbox_id: string; message_id: string }>();
	const readable = new Set(mailboxIds);
	const ids = new Set<string>();
	let seq = cursor.seq;
	let cut = false;
	for (const change of scanned.results) {
		if (readable.has(change.mailbox_id) && !ids.has(change.message_id)) {
			if (ids.size >= options.limit) { cut = true; break; }
			ids.add(change.message_id);
		}
		seq = change.seq;
	}
	const rows: ListRow[] = ids.size && mailboxIds.length ? await loadRows(db, [...ids], mailboxIds) : [];
	const found = new Set(rows.map((row) => row.id));
	rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
	return {
		cursor: encodeCursor({ ...cursor, seq }),
		more: cut || scanned.results.length === options.limit * 4,
		reset: false,
		mailboxIds,
		messages: await enrich(env, db, user, mailboxes, rows),
		removed: [...ids].filter((id) => !found.has(id)),
	};
}
