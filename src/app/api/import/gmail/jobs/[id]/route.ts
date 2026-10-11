import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { gmailImportJobs } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { advanceGmailJob, getOwnedGmailJob, publicGmailJob, skipGmailMessage } from "@/lib/import/gmail-jobs";
import { readJsonBody } from "@/lib/http/request";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
	const env = getEnv(), auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	try {
		const { id } = await context.params;
		const input = z.object({ action: z.enum(["advance", "pause", "skip"]) }).strict().parse(await readJsonBody(request, 1024));
		if (input.action === "pause") {
			await getOwnedGmailJob(env, auth.user, id);
			await getDb(env).update(gmailImportJobs).set({ status: "paused", leaseToken: null, leaseUntil: 0, updatedAt: new Date() }).where(and(eq(gmailImportJobs.id, id), eq(gmailImportJobs.userId, auth.user.id), ne(gmailImportJobs.status, "completed")));
		}
		const job = input.action === "advance" ? await advanceGmailJob(env, auth.user, id) : input.action === "skip" ? await skipGmailMessage(env, auth.user, id) : await getOwnedGmailJob(env, auth.user, id);
		return NextResponse.json({ job: publicGmailJob(job) }, { headers: { "Cache-Control": "private, no-store" } });
	} catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to advance import" }, { status: 400 }); }
}
