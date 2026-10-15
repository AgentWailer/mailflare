import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, driveShares, driveUploadParts, users } from "@/db/schema";
import { DRIVE_MAX_DEPTH, driveObjectKey } from "./utils";
import type { DriveItemDto, DriveRole, DriveRow } from "./types";

type Db = ReturnType<typeof getDb>;

export async function getDriveItem(db: Db, id: string): Promise<DriveRow | null> {
	const [item] = await db.select().from(driveItems).where(eq(driveItems.id, id)).limit(1);
	return item ?? null;
}

/** Ancestors from the root down to (and including) the item. Stops early at a missing parent. */
export async function getDriveChain(db: Db, item: DriveRow): Promise<DriveRow[]> {
	const chain: DriveRow[] = [item];
	let current = item;
	while (current.parentId && chain.length < DRIVE_MAX_DEPTH) {
		const parent = await getDriveItem(db, current.parentId);
		if (!parent) break;
		chain.unshift(parent);
		current = parent;
	}
	return chain;
}

/**
 * Effective role for a user. Shares on any ancestor apply to everything beneath it. A trashed item or
 * trashed ancestor is invisible unless `allowTrashed` (used by the owner's Trash view).
 */
export async function getDriveRole(db: Db, userId: string, item: DriveRow, allowTrashed = false): Promise<DriveRole | null> {
	const chain = await getDriveChain(db, item);
	if (!allowTrashed && chain.some((entry) => entry.trashedAt)) return null;
	if (item.ownerId === userId) return "owner";
	const shares = await db.select({ role: driveShares.role }).from(driveShares).where(and(eq(driveShares.userId, userId), inArray(driveShares.itemId, chain.map((entry) => entry.id))));
	if (shares.some((share) => share.role === "edit")) return "edit";
	return shares.length ? "view" : null;
}

/** Resolves a public link token to its root item, optionally narrowed to a descendant file. */
export async function getPublicDriveItem(db: Db, token: string, itemId?: string | null): Promise<{ root: DriveRow; item: DriveRow } | null> {
	const [root] = await db.select().from(driveItems).where(eq(driveItems.linkToken, token)).limit(1);
	if (!root || root.trashedAt) return null;
	if (!itemId || itemId === root.id) return { root, item: root };
	const item = await getDriveItem(db, itemId);
	if (!item) return null;
	const chain = await getDriveChain(db, item);
	if (chain.some((entry) => entry.trashedAt) || !chain.some((entry) => entry.id === root.id)) return null;
	return { root, item };
}

export async function toDriveItemDtos(db: Db, rows: DriveRow[], userId: string, roleFor?: (row: DriveRow) => DriveRole): Promise<DriveItemDto[]> {
	if (!rows.length) return [];
	const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
	const ownerQueries = Array.from({ length: Math.ceil(ownerIds.length / 80) }, (_, page) =>
		db.select({ id: users.id, name: users.name, email: users.email, avatarKey: users.avatarKey }).from(users).where(inArray(users.id, ownerIds.slice(page * 80, page * 80 + 80))));
	const shareQueries = Array.from({ length: Math.ceil(rows.length / 80) }, (_, page) =>
		db.selectDistinct({ itemId: driveShares.itemId }).from(driveShares).where(inArray(driveShares.itemId, rows.slice(page * 80, page * 80 + 80).map(row => row.id))));
	// Bounded batches replace a network round trip for every 50 visible files.
	const owners: Array<{ id: string; name: string; email: string; avatarKey: string | null }> = [];
	for (let offset = 0; offset < ownerQueries.length; offset += 25) {
		const group = ownerQueries.slice(offset, offset + 25);
		owners.push(...(await db.batch(group as [typeof group[number], ...typeof group[number][]])).flat());
	}
	const sharedIds = new Set<string>();
	for (let offset = 0; offset < shareQueries.length; offset += 25) {
		const group = shareQueries.slice(offset, offset + 25);
		for (const page of await db.batch(group as [typeof group[number], ...typeof group[number][]])) for (const share of page) sharedIds.add(share.itemId);
	}
	const ownerNames = new Map(owners.map(owner => [owner.id, owner.name || owner.email]));
	const ownerAvatars = new Map(owners.map(owner => [owner.id, !!owner.avatarKey]));
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		name: row.name,
		size: row.size,
		contentType: row.contentType,
		parentId: row.parentId,
		ownerId: row.ownerId,
		ownerName: ownerNames.get(row.ownerId) ?? "",
		ownerHasAvatar: ownerAvatars.get(row.ownerId) ?? false,
		role: roleFor ? roleFor(row) : row.ownerId === userId ? "owner" : "view",
		shared: sharedIds.has(row.id) || !!row.linkToken,
		linkToken: row.ownerId === userId ? row.linkToken : null,
		trashedAt: row.trashedAt?.toISOString() ?? null,
		updatedAt: row.updatedAt.toISOString(),
	}));
}

/** Every descendant of the given folders (breadth first), without the roots themselves. */
export async function collectDriveDescendants(db: Db, rootIds: string[]): Promise<DriveRow[]> {
	const found: DriveRow[] = [];
	let level = rootIds;
	for (let depth = 0; level.length && depth < DRIVE_MAX_DEPTH; depth += 1) {
		const next: DriveRow[] = [];
		for (let index = 0; index < level.length; index += 50) {
			next.push(...await db.select().from(driveItems).where(inArray(driveItems.parentId, level.slice(index, index + 50))));
		}
		found.push(...next);
		level = next.filter((row) => row.kind === "folder").map((row) => row.id);
	}
	return found;
}

/** Permanently removes items, their descendants and the stored objects. */
export async function deleteDriveItems(env: CloudflareEnv, roots: DriveRow[]): Promise<void> {
	const db = getDb(env);
	const descendants = await collectDriveDescendants(db, roots.filter((row) => row.kind === "folder").map((row) => row.id));
	const all = [...roots, ...descendants];
	const keys = all.filter((row) => row.kind === "file").map((row) => row.r2Key ?? driveObjectKey(row.ownerId, row.id));
	for (let index = 0; index < keys.length; index += 500) await env.BUCKET.delete(keys.slice(index, index + 500));
	const ids = all.map((row) => row.id);
	for (let index = 0; index < ids.length; index += 50) {
		const slice = ids.slice(index, index + 50);
		await db.delete(driveShares).where(inArray(driveShares.itemId, slice));
		await db.delete(driveUploadParts).where(inArray(driveUploadParts.itemId, slice));
		await db.delete(driveItems).where(inArray(driveItems.id, slice));
	}
}

/** Drops rows that sit under a trashed folder; only the folder itself carries `trashedAt`. */
export async function withoutTrashedAncestors(db: Db, rows: DriveRow[]): Promise<DriveRow[]> {
	type Ancestor = Pick<DriveRow, "id" | "parentId" | "trashedAt">;
	const ancestors = new Map<string, Ancestor | null>(rows.map(row => [row.id, row]));
	let frontier = [...new Set(rows.flatMap(row => row.parentId && !ancestors.has(row.parentId) ? [row.parentId] : []))];
	// Resolve the hierarchy by depth, rather than one query per folder/file.
	for (let depth = 0; frontier.length && depth < DRIVE_MAX_DEPTH; depth++) {
		const next = new Set<string>();
		for (let offset = 0; offset < frontier.length; offset += 80) {
			const ids = frontier.slice(offset, offset + 80);
			const parents = await db.select({ id: driveItems.id, parentId: driveItems.parentId, trashedAt: driveItems.trashedAt }).from(driveItems).where(inArray(driveItems.id, ids));
			for (const id of ids) ancestors.set(id, null);
			for (const parent of parents) ancestors.set(parent.id, parent);
			for (const parent of parents) if (!parent.trashedAt && parent.parentId && !ancestors.has(parent.parentId)) next.add(parent.parentId);
		}
		frontier = [...next].filter(id => !ancestors.has(id));
	}
	return rows.filter(row => {
		let id = row.parentId;
		for (let depth = 0; id && depth < DRIVE_MAX_DEPTH; depth++) {
			const parent = ancestors.get(id);
			if (!parent) break;
			if (parent.trashedAt) return false;
			id = parent.parentId;
		}
		return true;
	});
}
