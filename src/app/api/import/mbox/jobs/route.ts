import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { createMboxJob, listMboxJobs } from "@/lib/import/mbox-jobs";
import { readJsonBody } from "@/lib/http/request";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
 const env = getEnv(), auth = await requireSessionUser(env, request);
 if (auth.error) return auth.error;
 if (auth.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
 try {
  const mailboxId = z.string().min(1).max(100).parse(new URL(request.url).searchParams.get("mailboxId"));
  return NextResponse.json({ jobs: await listMboxJobs(env, auth.user, mailboxId), backgroundQueueConfigured: !!env.AGENT_QUEUE }, { headers });
 } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load MBOX imports" }, { status: 400, headers }); }
}
export async function POST(request: Request) {
 const env = getEnv(), auth = await requireSessionUser(env, request);
 if (auth.error) return auth.error;
 if (auth.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403, headers });
 try {
  const input = z.object({ mailboxId: z.string().min(1).max(100), objectKey: z.string().min(1).max(1024) }).strict().parse(await readJsonBody(request, 4096));
  return NextResponse.json({ job: await createMboxJob(env, auth.user, input.mailboxId, input.objectKey) }, { headers });
 } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start MBOX import" }, { status: 400, headers }); }
}
