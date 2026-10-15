import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { backups, backupSettings } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { BackupScheduleType, BackupTableGroupId } from "./types";
import { BACKUP_SETTINGS_ID, getUtcDayBounds, isBackupDue } from "./utils";
import { parseExcludedBackupTableGroups } from "./table-groups";
import { validateRescuePublicKey } from "./rescue-crypto";

export async function getBackupSettings(env: CloudflareEnv) {
	const db = getDb(env);
	const [settings] = await db
		.select()
		.from(backupSettings)
		.where(eq(backupSettings.id, BACKUP_SETTINGS_ID))
		.limit(1);
	return settings ? { ...settings, excludedTableGroups: parseExcludedBackupTableGroups(settings.excludedTableGroups) } : undefined;
}

export async function listBackups(env: CloudflareEnv) {
	return getDb(env).select({ id: backups.id, kind: backups.kind, phase: sql<string|null>`json_extract(${backups.checkpoint}, '$.phase')`, verifiedAt: backups.verifiedAt, objectCount: backups.objectCount, objectBytes: backups.objectBytes, status: backups.status, trigger: backups.trigger, r2Key: backups.r2Key, filename: backups.filename, size: backups.size, error: backups.error, createdByUserId: backups.createdByUserId, createdAt: backups.createdAt, startedAt: backups.startedAt, completedAt: backups.completedAt }).from(backups).orderBy(desc(backups.createdAt)).limit(100);
}

export async function createBackupRecord(
	env: CloudflareEnv,
	trigger: "manual" | "scheduled",
	createdByUserId?: string,
) {
	const id = newId("bak");
	if (!env.RESCUE_BUCKET && (env.MAILFLARE_RUNTIME !== "node" || (await getBackupSettings(env))?.rescuePublicKey)) throw new Error("A separate encrypted rescue bucket must be configured before starting a backup");
	if (env.RESCUE_BUCKET) {
		const settings = await getBackupSettings(env);
		validateRescuePublicKey(settings?.rescuePublicKey ? JSON.parse(settings.rescuePublicKey) : null);
		const inserted = await env.DB.prepare("INSERT INTO backups(id,kind,status,trigger,created_by_user_id,created_at) SELECT ?,'rescue','queued',?,?,? WHERE NOT EXISTS(SELECT 1 FROM backups WHERE status IN ('queued','running')) RETURNING id")
			.bind(id,trigger,createdByUserId??null,Math.floor(Date.now()/1000)).first<{id:string}>();
		if (inserted) return inserted.id;
		const active = await env.DB.prepare("SELECT id FROM backups WHERE status IN ('queued','running') LIMIT 1").first<{id:string}>();
		if (!active) throw new Error("Backup could not be started");
		return active.id;
	}
	await getDb(env).insert(backups).values({
		id,
		trigger,
		createdByUserId: createdByUserId ?? null,
	});
	return id;
}

export async function createScheduledBackupIfDue(env: CloudflareEnv, now: Date): Promise<string | null> {
	const settings = await getBackupSettings(env);
	if (!settings?.enabled) return null;
	if (!isBackupDue(settings.scheduleType as BackupScheduleType, settings.scheduleValue, now)) return null;

	const { start, end } = getUtcDayBounds(now);
	const existing = await getDb(env)
		.select({ id: backups.id })
		.from(backups)
		.where(
			and(
				eq(backups.trigger, "scheduled"),
				inArray(backups.status, ["queued", "running", "completed"]),
				gte(backups.createdAt, new Date(start)),
				lt(backups.createdAt, new Date(end)),
			),
		)
		.limit(1);
	if (existing.length) return null;
	return createBackupRecord(env, "scheduled");
}

export async function updateBackupSettings(
	env: CloudflareEnv,
	input: {
		enabled: boolean;
		scheduleType: BackupScheduleType;
		scheduleValue: number | null;
		retentionEnabled: boolean;
		retentionDays: number;
		excludedTableGroups: BackupTableGroupId[];
	},
) {
	if (env.RESCUE_BUCKET && input.enabled) {
		const current = await getBackupSettings(env);
		validateRescuePublicKey(current?.rescuePublicKey ? JSON.parse(current.rescuePublicKey) : null);
	}
	const { excludedTableGroups, ...settings } = input;
	await getDb(env)
		.update(backupSettings)
		.set({ ...settings, retentionEnabled: env.RESCUE_BUCKET ? false : settings.retentionEnabled, excludedTableGroups: JSON.stringify(env.RESCUE_BUCKET ? [] : excludedTableGroups), updatedAt: new Date() })
		.where(eq(backupSettings.id, BACKUP_SETTINGS_ID));
}

export async function deleteBackup(env: CloudflareEnv, id: string): Promise<boolean> {
	const db = getDb(env);
	const [backup] = await db.select().from(backups).where(eq(backups.id, id)).limit(1);
	if (!backup) return false;
	if (backup.kind === "rescue") throw new Error("A rescue point is replaced only after a new one has been verified");
	if (backup.status === "queued" || backup.status === "running") {
		throw new Error("A backup in progress cannot be deleted");
	}
	if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
	await db.delete(backups).where(eq(backups.id, id));
	return true;
}
