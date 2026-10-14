import type { BackupTableGroupId, DatabaseBackupTable, DatabaseRecord } from "./types";
import { assertBackupTablesCoverDatabase, getBackupTableOrder } from "./export";
import { getSelectedBackupTables } from "./table-groups";

const encoder = new TextEncoder();
const PAGE_BYTES = 256 * 1024;
const PAGE_ROWS = 500;
export const BACKUP_PART_BYTES = 5 * 1024 * 1024;

type TablePlan = { name: DatabaseBackupTable; upper: number | null; columns: string[] };
export type BackupExportPlan = { createdAt: string; tables: TablePlan[] };
export type BackupExportCursor = { started: boolean; table: number; opened: boolean; after: number | null; rows: boolean; done: boolean };
export const initialBackupCursor = (): BackupExportCursor => ({ started: false, table: 0, opened: false, after: null, rows: false, done: false });
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function planDatabaseBackup(db: D1Database, excludedGroups: BackupTableGroupId[] = []): Promise<BackupExportPlan> {
	const available = await assertBackupTablesCoverDatabase(db);
	const selected = getSelectedBackupTables(excludedGroups);
	const names = getBackupTableOrder().filter(table => selected.has(table));
	if (!names.length) throw new Error("Select at least one backup table group");
	const tables: TablePlan[] = [];
	for (const name of names) {
		if (!available.has(name)) { tables.push({ name, upper: null, columns: [] }); continue; }
		const columns = (await db.prepare(`PRAGMA table_info(${identifier(name)})`).all<{ name: string }>()).results.map(column => column.name);
		const boundary = await db.prepare(`SELECT max(rowid) AS upper FROM ${identifier(name)}`).first<{ upper: number | null }>();
		tables.push({ name, upper: boundary?.upper ?? null, columns });
	}
	return { createdAt: new Date().toISOString(), tables };
}

/** Cursor advances only past complete JSON frames; an unfinished frame is carried to the next part. */
async function* frames(db: D1Database, plan: BackupExportPlan, cursor: BackupExportCursor): AsyncGenerator<Uint8Array> {
	if (!cursor.started) {
		cursor.started = true;
		yield encoder.encode(JSON.stringify({ format: "mailflare-database-backup", version: 1, createdAt: plan.createdAt, includedTables: plan.tables.map(table => table.name) }).slice(0, -1) + ',"tables":{');
	}
	while (cursor.table < plan.tables.length) {
		const table = plan.tables[cursor.table];
		if (!cursor.opened) {
			cursor.opened = true;
			yield encoder.encode(`${cursor.table ? "," : ""}${JSON.stringify(table.name)}:[`);
		}
		let rows: (DatabaseRecord & { __mailflare_backup_rowid: number })[] = [];
		let boundary: number | null = null;
		if (table.upper !== null) {
			const filter = cursor.after === null ? "rowid <= ?" : "rowid > ? AND rowid <= ?";
			const params = cursor.after === null ? [table.upper] : [cursor.after, table.upper];
			// Estimate response bytes without fetching HTML/body values into a large D1 result.
			const size = table.columns.map(column => `coalesce(length(CAST(${identifier(column)} AS BLOB)),0)`).join("+") || "0";
			const candidates = (await db.prepare(`SELECT rowid AS id, (${size}) AS bytes FROM ${identifier(table.name)} WHERE ${filter} ORDER BY rowid LIMIT ${PAGE_ROWS}`).bind(...params).all<{ id: number; bytes: number }>()).results;
			let bytes = 0;
			for (const row of candidates) {
				if (boundary !== null && bytes + row.bytes > PAGE_BYTES) break;
				boundary = row.id; bytes += row.bytes;
			}
			if (boundary !== null) {
				const selectedParams = cursor.after === null ? [boundary] : [cursor.after, boundary];
				rows = (await db.prepare(`SELECT rowid AS __mailflare_backup_rowid, * FROM ${identifier(table.name)} WHERE ${filter} ORDER BY rowid LIMIT ${PAGE_ROWS}`).bind(...selectedParams).all<DatabaseRecord & { __mailflare_backup_rowid: number }>()).results;
			}
		}
		for (const row of rows) {
			const { __mailflare_backup_rowid: rowid, ...record } = row;
			const comma = cursor.rows ? "," : "";
			cursor.rows = true; cursor.after = rowid;
			yield encoder.encode(comma + JSON.stringify(record));
		}
		if (boundary !== null) { cursor.after = boundary; continue; }
		cursor.table++; cursor.opened = false; cursor.after = null; cursor.rows = false;
		yield encoder.encode("]");
	}
	if (!cursor.done) { cursor.done = true; yield encoder.encode("}}"); }
}

export async function nextDatabaseBackupPart(db: D1Database, plan: BackupExportPlan, previous: BackupExportCursor, carry = new Uint8Array(0), partBytes = BACKUP_PART_BYTES) {
	const cursor = { ...previous };
	const output = new Uint8Array(partBytes);
	let used = Math.min(carry.byteLength, partBytes);
	output.set(carry.subarray(0, used));
	let remainder: Uint8Array = carry.slice(used);
	if (!remainder.byteLength && used < partBytes) {
		for await (const frame of frames(db, plan, cursor)) {
			const take = Math.min(frame.byteLength, partBytes - used);
			output.set(frame.subarray(0, take), used); used += take;
			if (used === partBytes) { remainder = frame.slice(take); break; }
		}
	}
	return { content: output.slice(0, used), carry: remainder, cursor, done: cursor.done && !remainder.byteLength };
}
