import type { BackupTableGroupId, DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";
import { mergeLegacyMessageBodies } from "./utils";
import { BACKUP_TABLE_GROUPS, getSelectedBackupTables } from "./table-groups";

const BACKUP_TABLES: DatabaseBackupTable[] = ["users", "domains", "mailboxes", "mailbox_access", "contacts", "folders", "api_keys", "mcp_oauth_grants", "gmail_import_connections", "mbox_import_jobs", "mbox_import_issues", "message_bulk_jobs", "mbox_sorting_jobs", "gmail_import_jobs", "gmail_sent_sync", "gmail_sent_sync_issues", "messages", "message_labels", "mail_content_audit_jobs", "mail_content_audit_issues", "drive_items", "drive_shares", "mailbox_sorting_settings", "mail_sorting_overrides", "mail_sorting_feedback", "mail_sorting_usage", "message_attachments", "paperless_connections", "paperless_jobs", "shared_attachment_links", "outbound_jobs", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "license_settings", "email_templates", "calendar_events", "booking_events", "auto_reply_deliveries", "spam_token_stats", "spam_reputation", "spam_feedback", "mailbox_aliases", "password_reset_tokens", "mfa_recovery_codes", "login_challenges", "mailbox_agent_settings", "agent_conversations", "agent_chat_messages", "agent_jobs", "agent_draft_metadata", "agent_send_approvals", "mcp_key_mailboxes", 'ai_usage'];
/**
 * Tables every backup document must contain. Tables added to BACKUP_TABLES
 * after the format shipped are absent from older documents, so they stay
 * optional here and are filled in as empty on restore.
 */
const REQUIRED_BACKUP_TABLES: DatabaseBackupTable[] = ["users", "domains", "mailboxes", "mailbox_access", "contacts", "folders", "api_keys", "messages", "message_attachments", "outbound_jobs", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "license_settings"];
const INSERT_BATCH_SIZE = 50;

export function getBackupTableOrder(): readonly DatabaseBackupTable[] { return BACKUP_TABLES; }

export function getBackupConfigurationStatus(_env?: CloudflareEnv) {
	if (_env && _env.MAILFLARE_RUNTIME !== "node" && !_env.RESCUE_BUCKET) return { configured: false, missing: ["RESCUE_BUCKET"] };
	return { configured: true, missing: [] };
}

/**
 * Tables D1 manages itself, which are intentionally absent from BACKUP_TABLES.
 */
const INTERNAL_TABLE_PATTERNS = ["sqlite_%", "_cf%", "messages_fts%"];
/**
 * The search index is derived data: its triggers repopulate it as messages are
 * restored, so it is neither exported nor part of the coverage check.
 */
const INTERNAL_TABLES = [
	// Rescue-copy index is reconstructed from the manifest, not restored into live jobs.
	"backup_snapshot_objects",
	"backup_snapshot_links",
	// Transient CHECK-constraint rebuild during 0069; canonical feedback is backed up.
	"mail_sorting_feedback_v4",
	// Short-lived, single-use OAuth state and PKCE verifiers must never be restored.
	"gmail_oauth_states",
	"d1_migrations",
	// Device credentials must be renewed after restore; multipart parts are transient.
	"push_subscriptions",
	"drive_upload_parts",
	// JMAP state counters, also derived: the jmap_messages_* triggers on
	// `messages` insert and bump a row per mailbox as messages are restored.
	// Exporting it would make restore fail, since the triggers recreate these
	// primary keys before the table's own rows would be inserted.
	"jmap_mailbox_revisions",
];

/**
 * Fails the backup when the database contains a table BACKUP_TABLES does not
 * list. Without this, a migration that adds a table silently produces backups
 * that omit it, and the omission only surfaces during a restore.
 */
export async function assertBackupTablesCoverDatabase(db: D1Database): Promise<Set<string>> {
	const conditions = [
		...INTERNAL_TABLE_PATTERNS.map((pattern) => `name NOT LIKE '${pattern}'`),
		...INTERNAL_TABLES.map((name) => `name <> '${name}'`),
	].join(" AND ");
	const result = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND ${conditions}`)
		.all<{ name: string }>();
	const covered = new Set<string>(BACKUP_TABLES);
	const unlisted = result.results.map((row) => row.name).filter((name) => !covered.has(name));
	if (unlisted.length) throw new Error(`Backup aborted: ${unlisted.join(", ")} not listed in BACKUP_TABLES. Add new tables to src/lib/backups/export.ts and assign each to a group in table-groups.ts.`);
	const assigned = BACKUP_TABLE_GROUPS.flatMap((group) => group.tables);
	const ungrouped = BACKUP_TABLES.filter((table) => assigned.filter((item) => item === table).length !== 1);
	const unknown = assigned.filter((table) => !covered.has(table));
	if (ungrouped.length || unknown.length) throw new Error(`Backup aborted: table groups are out of sync (${[...ungrouped, ...unknown].join(", ")}). Update src/lib/backups/table-groups.ts.`);
	return new Set(result.results.map((row) => row.name));
}

export async function exportDatabaseRecords(db: D1Database, excludedGroups: BackupTableGroupId[] = []): Promise<Uint8Array> {
	const databaseTables = await assertBackupTablesCoverDatabase(db);
	const selected = getSelectedBackupTables(excludedGroups);
	const includedTables = BACKUP_TABLES.filter((table) => selected.has(table));
	if (!includedTables.length) throw new Error("Select at least one backup table group");
	const tables: DatabaseBackupDocument["tables"] = {};
	for (const table of includedTables) {
		if (!databaseTables.has(table)) {
			tables[table] = [];
			continue;
		}
		const result = await db.prepare(`SELECT * FROM ${table}`).all<DatabaseRecord>();
		tables[table] = result.results;
	}
	const document: DatabaseBackupDocument = { format: "mailflare-database-backup", version: 1, createdAt: new Date().toISOString(), includedTables, tables };
	return new TextEncoder().encode(JSON.stringify(document));
}

export async function restoreDatabaseRecords(db: D1Database, content: ArrayBuffer): Promise<void> {
	const document = parseDatabaseBackup(content);
	if (document.includedTables && !BACKUP_TABLE_GROUPS.every((group) => group.tables.some((table) => document.includedTables?.includes(table)))) throw new Error("This backup contains selected table groups only. Restore requires a backup that includes every table group.");
	mergeLegacyMessageBodies(document);
	fillMissingBackupTables(document);
	validateDatabaseBackup(document);
	const sharedLinksTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shared_attachment_links'").first<{ name: string }>();
	if (!sharedLinksTable && document.tables.shared_attachment_links?.length) throw new Error("Apply pending database migrations before restoring shared attachment links.");
	const bookingTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'booking_events'").first<{ name: string }>();
	if (!bookingTable && document.tables.booking_events?.length) throw new Error("Apply pending database migrations before restoring booking events.");
	const availableTables = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>()).results.map(row=>row.name));
 for(const table of BACKUP_TABLES) if(!availableTables.has(table) && document.tables[table]?.length) throw new Error(`Apply pending database migrations before restoring ${table}.`);
 const restoreTables = BACKUP_TABLES.filter(table=>availableTables.has(table));
 const feedbackColumns = availableTables.has("mail_sorting_feedback") ? new Set((await db.prepare("PRAGMA table_info(mail_sorting_feedback)").all<{name:string}>()).results.map(row=>row.name)) : new Set<string>();
 if (document.tables.mail_sorting_feedback?.some(row => "excerpt" in row || "source" in row) && (!feedbackColumns.has("excerpt") || !feedbackColumns.has("source"))) throw new Error("Apply pending database migrations before restoring content learning examples.");
 const messageColumns = new Set((await db.prepare("PRAGMA table_info(messages)").all<{name:string}>()).results.map(row=>row.name));
	const folderColumns = new Set((await db.prepare("PRAGMA table_info(folders)").all<{ name: string }>()).results.map((column) => column.name));
	if (!folderColumns.has("parent_id") && document.tables.folders?.some(row => row.parent_id)) throw new Error("Apply pending database migrations before restoring nested labels.");
	const backupColumns = new Set((await db.prepare("PRAGMA table_info(backups)").all<{ name: string }>()).results.map(column => column.name));
	const userColumns = new Set((await db.prepare("PRAGMA table_info(users)").all<{ name: string }>()).results.map((column) => column.name));
	const bookingColumns = bookingTable ? new Set((await db.prepare("PRAGMA table_info(booking_events)").all<{ name: string }>()).results.map((column) => column.name)) : null;
	for (const table of [...restoreTables].reverse()) await db.prepare(`DELETE FROM ${table}`).run();
	for (const table of restoreTables) {
		if(table === "message_labels") await db.prepare("DELETE FROM message_labels").run();
		const rows = document.tables[table] ?? [];
		for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
			const columns = table === "folders" ? folderColumns : table === "users" ? userColumns : table === "backups" ? backupColumns : table === "messages" ? messageColumns : table === "routing_rules" ? new Set((await db.prepare("PRAGMA table_info(routing_rules)").all<{name:string}>()).results.map(row=>row.name)) : table === "booking_events" ? bookingColumns : null;
			const statements = rows.slice(index, index + INSERT_BATCH_SIZE).map((row) => createInsertStatement(db, table, table === "backups" ? { ...row, checkpoint: null, lease_token: null, lease_until: 0, status: ["queued", "running"].includes(String(row.status)) ? "failed" : row.status, error: ["queued", "running"].includes(String(row.status)) ? "Restored backup requires a new export" : row.error } : (table === "gmail_import_jobs" || table === "mbox_import_jobs" || table === "mbox_sorting_jobs") ? { ...row, lease_token: null, lease_until: 0, status: ((table === "mbox_import_jobs" || table === "mbox_sorting_jobs") && ["pending", "running", "waiting"].includes(String(row.status))) || row.status === "running" ? "paused" : row.status } : table === "mcp_oauth_grants" ? { ...row, enabled: 0 } : table === "gmail_sent_sync" ? { ...row, enabled: 0, lease_token: null, lease_until: 0, error: "restore_requires_review" } : table === "paperless_connections" ? { ...row, enabled: 0 } : table === "paperless_jobs" ? { ...row, lease_token: null, lease_until: 0, status: ["completed","cancelled"].includes(String(row.status)) ? row.status : "paused", error: ["completed","cancelled"].includes(String(row.status)) ? row.error : "restore_requires_review" } : table === "mail_content_audit_jobs" ? { ...row, lease_token: null, lease_until: 0, status: ["pending","running","waiting","paused","failed"].includes(String(row.status)) ? "paused" : row.status, error: ["pending","running","waiting","paused","failed"].includes(String(row.status)) ? "restore_requires_restart" : row.error } : table === "message_bulk_jobs" ? { ...row, lease_token: null, lease_until: 0, pending_chunk: null, status: ["pending","running","waiting","failed","paused"].includes(String(row.status)) ? "paused" : row.status, error: ["pending","running","waiting","failed","paused"].includes(String(row.status)) ? "Restored selection requires a new background action" : row.error } : table === "folders" && folderColumns.has("parent_id") ? { ...row, parent_id: null } : row, columns));
			if (statements.length > 0) await db.batch(statements);
		}
		// Restore all labels before their self-references, regardless of backup row order.
		if (table === "folders" && folderColumns.has("parent_id")) {
			const nested = rows.filter(row => row.parent_id);
			for (let index = 0; index < nested.length; index += INSERT_BATCH_SIZE) {
				await db.batch(nested.slice(index, index + INSERT_BATCH_SIZE).map(row => db.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").bind(row.parent_id, row.id)));
			}
		}
	}
	if(availableTables.has("message_labels")) await db.prepare("INSERT OR IGNORE INTO message_labels(message_id,folder_id) SELECT id,folder_id FROM messages WHERE folder_id IS NOT NULL").run();
}

function parseDatabaseBackup(content: ArrayBuffer): DatabaseBackupDocument {
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(content)); } catch { throw new Error("The selected file is not a valid Mailflare backup"); }
	if (!isDatabaseBackupDocument(value)) throw new Error("The selected file is not a valid Mailflare backup");
	return value;
}

function isDatabaseBackupDocument(value: unknown): value is DatabaseBackupDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<DatabaseBackupDocument>;
	if (document.format !== "mailflare-database-backup" || document.version !== 1 || !document.tables) return false;
	if (document.includedTables) {
		if (!Array.isArray(document.includedTables) || !document.includedTables.length || new Set(document.includedTables).size !== document.includedTables.length) return false;
		if (!document.includedTables.every((table) => BACKUP_TABLES.includes(table) && Array.isArray(document.tables?.[table]))) return false;
	} else if (!REQUIRED_BACKUP_TABLES.every((table) => Array.isArray(document.tables?.[table]))) return false;
	return BACKUP_TABLES.every((table) => {
		const rows = document.tables?.[table];
		return rows === undefined || Array.isArray(rows);
	});
}

function createInsertStatement(db: D1Database, table: DatabaseBackupTable, row: DatabaseRecord, availableColumns: Set<string> | null = null) {
	const columns = Object.keys(row).filter((column) => !availableColumns || availableColumns.has(column));
	if (columns.length === 0) throw new Error(`Backup contains an invalid ${table} record`);
	const placeholders = columns.map(() => "?").join(", ");
	const identifiers = columns.map((column) => `\`${column.replaceAll("`", "``")}\``).join(", ");
	return db.prepare(`INSERT INTO ${table} (${identifiers}) VALUES (${placeholders})`).bind(...columns.map((column) => row[column]));
}

/** Backups written before a table joined BACKUP_TABLES simply omit it. */
function fillMissingBackupTables(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		if (!document.tables[table]) document.tables[table] = [];
	}
	for (const row of document.tables.booking_events ?? []) {
		if (row.slug === undefined && typeof row.id === "string") row.slug = Array.from(new TextEncoder().encode(row.id)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
	}
}

function validateDatabaseBackup(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		for (const row of document.tables[table] ?? []) {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(`Backup contains an invalid ${table} record`);
			}
		}
	}
}
