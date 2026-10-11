import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, gmailImportConnections, gmailImportJobs, messageLabels } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { validLabelIds } from "@/lib/mail-sorting/labels";
import type { SessionUser } from "@/lib/auth/types";
import { importMessageToMailbox } from "./service";
import { decodeBase64, GmailError, gmailRequest } from "./gmail-oauth";
import type { ImportMessageInput } from "./types";
import type { ImportDestination } from "./destination-types";

export type GmailJob = typeof gmailImportJobs.$inferSelect;
type Cursor = { pageToken: string | null; nextPageToken?: string | null; pending: string[]; loaded: boolean };
type GoogleMessage = { id: string; labelIds?: string[]; raw?: string; internalDate?: string; threadId?: string; sizeEstimate?: number };
export function gmailPlacement(labels: string[]): { destination: ImportDestination; metadata: NonNullable<ImportMessageInput["metadata"]> } {
	const set = new Set(labels);
	const section = set.has("TRASH") ? "trash" : set.has("SPAM") ? "spam" : set.has("DRAFT") ? "drafts" : set.has("SENT") ? "sent" : set.has("INBOX") ? "inbox" : "archived";
	return { destination: { type: "system", section }, metadata: { read: !set.has("UNREAD"), starred: set.has("STARRED"), direction: set.has("SENT") || set.has("DRAFT") ? "outbound" : "inbound", category: set.has("CATEGORY_SOCIAL") ? "social" : set.has("CATEGORY_PROMOTIONS") ? "promotions" : "primary" } };
}
export function publicGmailJob(job: GmailJob) {
	let canSkip = false;
	try { canSkip = job.status === "failed" && !job.leaseToken && (JSON.parse(job.cursor) as Cursor).pending.length > 0; } catch { /* An invalid saved cursor must not authorize skipping. */ }
	return { id: job.id, mailboxId: job.mailboxId, connectionId: job.connectionId, status: job.status, processed: job.processed, imported: job.imported, skipped: job.skipped, total: job.total, error: job.error, createdAt: job.createdAt, canSkip };
}
export async function skipGmailMessage(env: CloudflareEnv, user: SessionUser, id: string) {
	const job = await getOwnedGmailJob(env, user, id);
	if (!publicGmailJob(job).canSkip) throw new Error("Only an interrupted message can be skipped");
	const cursor = JSON.parse(job.cursor) as Cursor; cursor.pending.shift();
	const [updated] = await getDb(env).update(gmailImportJobs).set({ cursor: JSON.stringify(cursor), status: "paused", error: null, processed: sql`${gmailImportJobs.processed} + 1`, skipped: sql`${gmailImportJobs.skipped} + 1`, updatedAt: new Date() })
		.where(and(eq(gmailImportJobs.id, id), eq(gmailImportJobs.userId, user.id), eq(gmailImportJobs.status, "failed"), isNull(gmailImportJobs.leaseToken), eq(gmailImportJobs.cursor, job.cursor))).returning();
	if (!updated) throw new Error("Import changed; reload before skipping");
	return updated;
}
export async function getOwnedGmailJob(env: CloudflareEnv, user: SessionUser, id: string) {
	const db = getDb(env);
	const [job] = await db.select().from(gmailImportJobs).where(and(eq(gmailImportJobs.id, id), eq(gmailImportJobs.userId, user.id))).limit(1);
	if (!job || !(await getMailboxAccessLevel(db, user, job.mailboxId))?.canManage) throw new Error("Import job not found or mailbox permission changed");
	return job;
}
export async function createGmailJob(env: CloudflareEnv, user: SessionUser, connectionId: string, mailboxId: string) {
	const db = getDb(env), access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) throw new Error("Mailbox not found or import permission denied");
	const [connection] = await db.select().from(gmailImportConnections).where(and(eq(gmailImportConnections.id, connectionId), eq(gmailImportConnections.userId, user.id))).limit(1);
	if (!connection) throw new Error("Google connection not found");
	const [active] = await db.select().from(gmailImportJobs).where(and(eq(gmailImportJobs.userId, user.id), eq(gmailImportJobs.mailboxId, mailboxId), eq(gmailImportJobs.connectionId, connectionId), ne(gmailImportJobs.status, "completed"))).limit(1);
	if (active) return active;
	const labels = await gmailRequest<{ labels?: { id: string; name: string; type: string; color?: { backgroundColor?: string } }[] }>(env, connection, "/labels");
	const map: Record<string, string> = {};
	// Preserve Google's full label names (including slash paths) without merging same-named children.
	const wanted = (labels.labels ?? []).filter(label => label.type === "user" && label.id && label.name);
	const known = new Set((await db.select({ name: folders.name }).from(folders).where(eq(folders.mailboxId, mailboxId))).map(folder => folder.name));
	const missing = wanted.filter(label => !known.has(label.name));
	// Bound SQL parameters and avoid three D1 requests per label on large accounts.
	for (let offset = 0; offset < missing.length; offset += 10) {
		await db.insert(folders).values(missing.slice(offset, offset + 10).map(label => ({ id: newId("fld"), userId: access.mailbox.userId, mailboxId, name: label.name, color: /^#[a-f0-9]{6}$/i.test(label.color?.backgroundColor ?? "") ? label.color!.backgroundColor : "#2563eb" }))).onConflictDoNothing();
	}
	const saved = new Map((await db.select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.mailboxId, mailboxId))).map(folder => [folder.name, folder.id]));
	for (const label of wanted) { const id = saved.get(label.name); if (id) map[label.id] = id; }
	const id = newId("gimport");
	const [inserted] = await db.insert(gmailImportJobs).values({ id, userId: user.id, mailboxId, connectionId, labelMap: JSON.stringify(map) }).onConflictDoNothing().returning();
	if (inserted) return inserted;
	const [concurrent] = await db.select().from(gmailImportJobs).where(and(eq(gmailImportJobs.userId, user.id), eq(gmailImportJobs.mailboxId, mailboxId), eq(gmailImportJobs.connectionId, connectionId), ne(gmailImportJobs.status, "completed"))).orderBy(desc(gmailImportJobs.createdAt)).limit(1);
	if (!concurrent) throw new Error("Retry creating the import");
	return concurrent;
}
export async function advanceGmailJob(env: CloudflareEnv, user: SessionUser, id: string) {
	let job = await getOwnedGmailJob(env, user, id);
	if (job.status === "completed") return job;
	const db = getDb(env), lease = newId("lease");
	const [locked] = await db.update(gmailImportJobs).set({ status: "running", leaseToken: lease, leaseUntil: Date.now() + 5 * 60_000, error: null })
		.where(and(eq(gmailImportJobs.id, id), eq(gmailImportJobs.userId, user.id), ne(gmailImportJobs.status, "completed"), or(isNull(gmailImportJobs.leaseToken), lt(gmailImportJobs.leaseUntil, Date.now())))).returning();
	if (!locked) throw new Error("An import batch is already running. Wait before resuming.");
	job = locked;
	const ownedLease = and(eq(gmailImportJobs.id, id), eq(gmailImportJobs.userId, user.id), eq(gmailImportJobs.leaseToken, lease));
	try {
		const [connection] = await db.select().from(gmailImportConnections).where(and(eq(gmailImportConnections.id, job.connectionId), eq(gmailImportConnections.userId, user.id))).limit(1);
		if (!connection) throw new Error("Reconnect Google before resuming");
		const access = await getMailboxAccessLevel(db, user, job.mailboxId);
		if (!access?.canManage) throw new Error("Mailbox import permission changed");
		const cursor = JSON.parse(job.cursor) as Cursor, labels = JSON.parse(job.labelMap) as Record<string, string>;
		if (!cursor.pending.length && !cursor.loaded) {
			const params = new URLSearchParams({ maxResults: "20", includeSpamTrash: "true", q: `before:${Math.floor(job.createdAt.getTime() / 1000) + 1} -in:chats` });
			if (cursor.pageToken) params.set("pageToken", cursor.pageToken);
			const page = await gmailRequest<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(env, connection, `/messages?${params}`);
			cursor.pending = (page.messages ?? []).map(message => message.id); cursor.nextPageToken = page.nextPageToken ?? null; cursor.loaded = true;
			const [saved] = await db.update(gmailImportJobs).set({ cursor: JSON.stringify(cursor), total: Math.max(job.total, page.resultSizeEstimate ?? 0, job.processed + cursor.pending.length), updatedAt: new Date() }).where(ownedLease).returning();
			if (!saved) throw new Error("Import was paused or disconnected"); job = saved;
		}
		for (let batch = 0; cursor.pending.length && batch < 3; batch++) {
			const [renewed] = await db.update(gmailImportJobs).set({ leaseUntil: Date.now() + 5 * 60_000 }).where(ownedLease).returning({ id: gmailImportJobs.id });
			if (!renewed) throw new Error("Import was paused or disconnected");
			const sourceId = cursor.pending[0]; let created = false;
			try {
				const metadata = await gmailRequest<GoogleMessage>(env, connection, `/messages/${encodeURIComponent(sourceId)}?format=metadata&fields=id,sizeEstimate`);
				if ((metadata.sizeEstimate ?? 0) > 40 * 1024 * 1024) throw new Error(`Google message ${sourceId} exceeds the 40 MB import limit. Export it separately before skipping this message.`);
				const remote = await gmailRequest<GoogleMessage>(env, connection, `/messages/${encodeURIComponent(sourceId)}?format=raw`);
				if (!remote.raw || remote.raw.length > 56 * 1024 * 1024) throw new Error("Google message is missing or exceeds the import memory limit");
				const raw = decodeBase64(remote.raw).buffer; remote.raw = undefined;
				const placement = gmailPlacement(remote.labelIds ?? []);
				const date = Number(remote.internalDate);
				if (Number.isFinite(date) && date > 0) placement.metadata.date = new Date(date);
				placement.metadata.sourceKey = `gmail:${connection.email}:${sourceId}`;
				if (remote.threadId) placement.metadata.threadId = `gmail:${connection.email}:${remote.threadId}`;
				// Check again before writing after the network wait, including a paused/deleted job.
				const [live] = await db.update(gmailImportJobs).set({ leaseUntil: Date.now() + 5 * 60_000 }).where(ownedLease).returning({ id: gmailImportJobs.id });
				if (!live) throw new Error("Import was paused or disconnected");
				const imported = await importMessageToMailbox(env, { userId: placement.metadata.direction === "outbound" ? user.id : access.mailbox.userId, mailboxId: job.mailboxId, filename: sourceId, raw, ...placement });
				created = imported.created;
				const ids = [...new Set((remote.labelIds ?? []).map(label => labels[label]).filter(Boolean))];
				for (let offset = 0; offset < ids.length; offset += 40) {
					// Respect labels removed during an import and bound D1 query parameters.
					const valid = await validLabelIds(db, job.mailboxId, ids.slice(offset, offset + 40));
					if (valid.length) await db.insert(messageLabels).values(valid.map(folderId => ({ messageId: imported.id, folderId }))).onConflictDoNothing();
				}
			} catch (error) { if (!(error instanceof GmailError) || error.status !== 404) throw error; }
			cursor.pending.shift();
			const [saved] = await db.update(gmailImportJobs).set({ cursor: JSON.stringify(cursor), processed: sql`${gmailImportJobs.processed} + 1`, imported: sql`${gmailImportJobs.imported} + ${created ? 1 : 0}`, skipped: sql`${gmailImportJobs.skipped} + ${created ? 0 : 1}`, updatedAt: new Date() }).where(ownedLease).returning();
			if (!saved) throw new Error("Import was paused or disconnected"); job = saved;
		}
		let complete = false;
		if (!cursor.pending.length) {
			if (cursor.nextPageToken) { cursor.pageToken = cursor.nextPageToken; cursor.loaded = false; cursor.nextPageToken = null; }
			else complete = true;
		}
		await db.update(gmailImportJobs).set({ cursor: JSON.stringify(cursor), status: complete ? "completed" : "paused", total: complete ? job.processed : job.total, leaseToken: null, leaseUntil: 0, error: null, updatedAt: new Date() }).where(ownedLease);
	} catch (error) {
		await db.update(gmailImportJobs).set({ status: "failed", leaseToken: null, leaseUntil: 0, error: error instanceof GmailError ? error.message : error instanceof Error ? error.message.slice(0, 200) : "Import failed. Resume or reconnect Google.", updatedAt: new Date() }).where(ownedLease);
	}
	return getOwnedGmailJob(env, user, id);
}
