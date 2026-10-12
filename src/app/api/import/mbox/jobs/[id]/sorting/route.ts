import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { controlMboxSortingJob } from "@/lib/import/mbox-sorting";
import { readJsonBody } from "@/lib/http/request";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
 const env = getEnv(), auth = await requireSessionUser(env, request);
 if (auth.error) return auth.error;
 if (auth.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 try {
  const input = z.object({ action: z.enum(["start", "pause", "resume"]) }).strict().parse(await readJsonBody(request, 1024));
  return NextResponse.json({ sorting: await controlMboxSortingJob(env, auth.user, (await context.params).id, input.action) }, { headers: { "Cache-Control": "private, no-store" } });
 } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update archive sorting" }, { status: 400 }); }
}
