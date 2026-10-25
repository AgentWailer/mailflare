import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { gmailImportConnections, gmailImportJobs } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { gmailConfiguration } from "@/lib/import/gmail-oauth";
import { publicGmailJob } from "@/lib/import/gmail-jobs";

import { gmailSentSyncStatus } from "@/lib/import/gmail-sent-sync";

export async function GET(request: Request) {
	const env = getEnv(), auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const db = getDb(env);
	const connections = await db.select({ id: gmailImportConnections.id, email: gmailImportConnections.email }).from(gmailImportConnections).where(eq(gmailImportConnections.userId, auth.user.id));
	const jobs = await db.select().from(gmailImportJobs).where(eq(gmailImportJobs.userId, auth.user.id)).orderBy(desc(gmailImportJobs.createdAt)).limit(30);
	const params = new URL(request.url).searchParams;
	const preferredConnectionId = connections.find(connection => connection.id === params.get("connection"))?.id ?? null;
	return NextResponse.json({ ...gmailConfiguration(env), authorizationFailed: params.get("callback") === "error", preferredConnectionId, connections, sentSyncs: await gmailSentSyncStatus(env, auth.user.id), jobs: jobs.map(publicGmailJob) }, { headers: { "Cache-Control": "private, no-store" } });
}
