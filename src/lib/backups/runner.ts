import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema";
import { newId } from "@/lib/ids";
import { safeErrorCategory } from "@/lib/security/logging";
import { createScheduledBackupIfDue, getBackupSettings } from "./service";
import { BACKUP_PREFIX, createBackupFilename } from "./utils";
import { initialBackupCursor, nextDatabaseBackupPart, planDatabaseBackup, type BackupExportCursor, type BackupExportPlan } from "./stream";
import { processRescueBackup } from "./rescue-runner";

type Checkpoint = {
	version: 1; plan: BackupExportPlan; cursor: BackupExportCursor;
	uploadId: string; key: string; filename: string; parts: R2UploadedPart[];
	size: number; carryKey: string | null; done: boolean; failures: number;
};
const LEASE_MS = 5 * 60_000;

async function cleanCarryObjects(env: CloudflareEnv, id: string) {
	let cursor: string | undefined;
	do {
		const result = await env.BUCKET.list({ prefix: `${BACKUP_PREFIX}/${id}/carry-`, ...(cursor ? { cursor } : {}) });
		if (result.objects.length) await env.BUCKET.delete(result.objects.map(object => object.key));
		cursor = result.truncated ? result.cursor : undefined;
	} while (cursor);
}

export async function enqueueDatabaseBackup(env: CloudflareEnv, backupId: string): Promise<void> {
	if (env.AGENT_QUEUE) await env.AGENT_QUEUE.send({ kind: "database.backup", jobId: backupId });
	else await runDatabaseBackup(env, backupId);
}

/** One bounded part per invocation; checkpoints survive closing the browser and duplicate deliveries. */
export async function processDatabaseBackup(env: CloudflareEnv, backupId: string): Promise<void> {
	const kind = await env.DB.prepare("SELECT kind FROM backups WHERE id=?").bind(backupId).first<{kind:string}>();
	if (kind?.kind === "rescue") return processRescueBackup(env, backupId);
	const now = Date.now(), lease = newId("lease");
	const job = await env.DB.prepare("UPDATE backups SET status='running',started_at=coalesce(started_at,?),lease_token=?,lease_until=? WHERE id=? AND status IN ('queued','running') AND lease_until<? RETURNING checkpoint")
		.bind(Math.floor(now / 1000), lease, now + LEASE_MS, backupId, now).first<{ checkpoint: string | null }>();
	if (!job) return;
	let state: Checkpoint | undefined;
	try {
		if (job.checkpoint) state = JSON.parse(job.checkpoint) as Checkpoint;
		else {
			const settings = await getBackupSettings(env);
			const plan = await planDatabaseBackup(env.DB, settings?.excludedTableGroups ?? []);
			const filename = createBackupFilename(new Date());
			const key = `${BACKUP_PREFIX}/${backupId}/${filename}`;
			const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: "application/json" }, customMetadata: { backupId } });
			state = { version: 1, plan, cursor: initialBackupCursor(), uploadId: upload.uploadId, key, filename, parts: [], size: 0, carryKey: null, done: false, failures: 0 };
			await env.DB.prepare("UPDATE backups SET checkpoint=?,r2_key=?,filename=? WHERE id=? AND lease_token=?").bind(JSON.stringify(state), key, filename, backupId, lease).run();
		}
		const upload = env.BUCKET.resumeMultipartUpload(state.key, state.uploadId);
		if (!state.done) {
			const previousCarry = state.carryKey;
			const carry = previousCarry ? await env.BUCKET.get(previousCarry) : null;
			if (previousCarry && !carry) throw new Error("Backup carry object missing");
			const part = await nextDatabaseBackupPart(env.DB, state.plan, state.cursor, carry ? new Uint8Array(await carry.arrayBuffer()) : undefined);
			if (!part.content.byteLength) throw new Error("Backup part was empty");
			const partNumber = state.parts.length + 1;
			if (partNumber > 10_000) throw new Error("Backup exceeds multipart capacity");
			const uploaded = await upload.uploadPart(partNumber, part.content);
			const carryKey = part.carry.byteLength ? `${BACKUP_PREFIX}/${backupId}/carry-${partNumber}` : null;
			if (carryKey) await env.BUCKET.put(carryKey, part.carry);
			state = { ...state, cursor: part.cursor, parts: [...state.parts, uploaded], size: state.size + part.content.byteLength, carryKey, done: part.done, failures: 0 };
			// Commit the cursor only after the part and its tail are durable. A retry overwrites the same part.
			await env.DB.prepare("UPDATE backups SET checkpoint=?,size=?,error=NULL WHERE id=? AND lease_token=?").bind(JSON.stringify(state), state.size, backupId, lease).run();
			if (previousCarry) await env.BUCKET.delete(previousCarry).catch(() => {});
		}
		if (state.done) {
			// complete() may have succeeded just before a Worker died; accept the matching final object.
			const existing = await env.BUCKET.head(state.key);
			const object = existing?.size === state.size ? existing : await upload.complete(state.parts);
			if (object.size !== state.size) throw new Error("Backup size verification failed");
			await env.DB.prepare("UPDATE backups SET status='completed',checkpoint=NULL,error=NULL,completed_at=?,lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?").bind(Math.floor(Date.now() / 1000), backupId, lease).run();
			await cleanCarryObjects(env, backupId).catch(() => {});
			await deleteExpiredBackups(env);
		} else {
			await env.DB.prepare("UPDATE backups SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?").bind(backupId, lease).run();
			// A lost queue send is recovered by the cron from the committed checkpoint.
			if (env.AGENT_QUEUE) await env.AGENT_QUEUE.send({ kind: "database.backup", jobId: backupId }).catch(() => {});
		}
	} catch (error) {
		// Keep the last committed checkpoint, never the in-memory cursor of a failed upload.
		const row = await env.DB.prepare("SELECT checkpoint FROM backups WHERE id=? AND lease_token=?").bind(backupId, lease).first<{ checkpoint: string | null }>();
		const saved = row?.checkpoint ? JSON.parse(row.checkpoint) as Checkpoint : null;
		const failures = (saved?.failures ?? 0) + 1;
		if (saved) saved.failures = failures;
		const failed = failures >= 5 || !saved;
		await env.DB.prepare("UPDATE backups SET status=?,checkpoint=?,error=?,lease_token=NULL,lease_until=?,completed_at=? WHERE id=? AND lease_token=?")
			.bind(failed ? "failed" : "running", saved ? JSON.stringify(saved) : null, `Backup interrupted (${safeErrorCategory(error)}). ${failed ? "Start a new backup." : "It will resume automatically."}`, failed ? 0 : Date.now() + 60_000, failed ? Math.floor(Date.now() / 1000) : null, backupId, lease).run();
		if (failed && saved && !saved.done) await env.BUCKET.resumeMultipartUpload(saved.key, saved.uploadId).abort().catch(() => {});
	}
}

/** Synchronous fallback for runtimes without a queue; production uses processDatabaseBackup. */
export async function runDatabaseBackup(env: CloudflareEnv, backupId: string): Promise<void> {
	while (true) {
		await processDatabaseBackup(env, backupId);
		const row = await env.DB.prepare("SELECT status,lease_until FROM backups WHERE id=?").bind(backupId).first<{ status: string; lease_until: number }>();
		if (!row || row.status === "completed") return;
		if (row.status === "failed" || row.lease_until > Date.now()) throw new Error("Backup interrupted; retry later");
	}
}

export async function recoverDatabaseBackups(env: CloudflareEnv): Promise<void> {
	const jobs = await env.DB.prepare("SELECT id FROM backups WHERE status IN ('queued','running') AND lease_until<? ORDER BY created_at LIMIT 5").bind(Date.now()).all<{ id: string }>();
	for (const job of jobs.results) await enqueueDatabaseBackup(env, job.id).catch(() => {});
}

export async function runScheduledDatabaseBackup(env: CloudflareEnv, now: Date): Promise<void> {
	const backupId = await createScheduledBackupIfDue(env, now);
	if (backupId) await enqueueDatabaseBackup(env, backupId);
	await deleteExpiredBackups(env);
}

export async function deleteExpiredBackups(env: CloudflareEnv): Promise<number> {
	// The single rescue point has no age expiry; replacement performs bounded cleanup after verification.
	if (env.RESCUE_BUCKET) return 0;
	const settings = await getBackupSettings(env);
	if (!settings?.retentionEnabled) return 0;
	const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
	const db = getDb(env);
	const expired = await db.select({ id: backups.id, r2Key: backups.r2Key }).from(backups).where(and(lt(backups.createdAt, cutoff), inArray(backups.status, ["completed", "failed"])));
	for (const backup of expired) {
		if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
		await cleanCarryObjects(env, backup.id);
		await db.delete(backups).where(eq(backups.id, backup.id));
	}
	return expired.length;
}
