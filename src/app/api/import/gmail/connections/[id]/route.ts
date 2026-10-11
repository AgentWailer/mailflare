import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { gmailImportConnections, gmailImportJobs } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
	const env = getEnv(), auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await context.params, db = getDb(env);
	// Imported emails are independent of this connection and remain in Mailflare.
	await db.update(gmailImportJobs).set({ leaseToken: null, leaseUntil: 0, status: "paused" }).where(and(eq(gmailImportJobs.connectionId, id), eq(gmailImportJobs.userId, auth.user.id)));
	const removed = await db.delete(gmailImportConnections).where(and(eq(gmailImportConnections.id, id), eq(gmailImportConnections.userId, auth.user.id))).returning({ id: gmailImportConnections.id });
	return NextResponse.json({ removed: removed.length > 0 }, { headers: { "Cache-Control": "private, no-store" } });
}
