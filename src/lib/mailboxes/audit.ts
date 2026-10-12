import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { AuditLogInput } from "./types";

export async function createAuditLog(env: CloudflareEnv, input: AuditLogInput): Promise<void> {
	const db = getDb(env);
	await db.insert(auditLogs).values(auditValues(input));
}

function auditValues(input: AuditLogInput) {
	return {
		id: newId("aud"),
		actorUserId: input.actorUserId ?? null,
		targetUserId: input.targetUserId ?? null,
		mailboxId: input.mailboxId ?? null,
		messageId: input.messageId ?? null,
		action: input.action,
		metadata: input.metadata ? JSON.stringify(input.metadata) : null,
	};
}

/** Preserve per-message records while avoiding one database round trip per message. */
export async function createBulkAuditLogs(env: CloudflareEnv, inputs: AuditLogInput[]): Promise<void> {
	const db = getDb(env);
	// Ten rows also leave headroom under D1's 100 bound parameters per statement.
	for (let offset = 0; offset < inputs.length; offset += 10) {
		await db.insert(auditLogs).values(inputs.slice(offset, offset + 10).map(auditValues));
	}
}
