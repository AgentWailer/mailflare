import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { createGmailJob, publicGmailJob } from "@/lib/import/gmail-jobs";
import { readJsonBody } from "@/lib/http/request";

export async function POST(request: Request) {
	const env = getEnv(), auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	try {
		const input = z.object({ connectionId: z.string().min(1).max(100), mailboxId: z.string().min(1).max(100) }).strict().parse(await readJsonBody(request, 2048));
		return NextResponse.json({ job: publicGmailJob(await createGmailJob(env, auth.user, input.connectionId, input.mailboxId)) }, { headers: { "Cache-Control": "private, no-store" } });
	} catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create import" }, { status: 400 }); }
}
