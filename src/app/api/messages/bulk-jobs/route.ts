import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonBody } from "@/lib/http/request";
import { bulkScopeSchema } from "@/lib/messages/bulk-scope";
import { createBulkJob, latestBulkJob, controlBulkJob } from "@/lib/messages/bulk-jobs";
const scopeSchema = z.object({ folder: bulkScopeSchema.shape.folder, mailboxId: z.string().max(200).optional(), folderId: z.string().max(200).optional(), query: z.string().max(4096), unreadOnly: z.boolean(), title: z.string().max(200) }).strict();
const schema = z.object({ input: bulkScopeSchema, scope: scopeSchema, requestId: z.string().min(1).max(200) }).strict();
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
 const env = getEnv(), { user, error } = await requireSessionUser(env, request);if (error) return error;
 return NextResponse.json({ job: await latestBulkJob(env, user.id) }, { headers });
}
export async function POST(request: Request) {
 const env = getEnv(), { user, error } = await requireSessionUser(env, request);if (error) return error;
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 const parsed = schema.safeParse(await readJsonBody(request, 32768).catch(() => null));
 if (!parsed.success || (parsed.data.input.action === "select" || parsed.data.input.action === "applyRule" || parsed.data.input.ruleApplication)) return NextResponse.json({ error: "Invalid background action" }, { status: 400 });
 const result = await createBulkJob(env, user, parsed.data.input, parsed.data.scope, parsed.data.requestId);
 return result instanceof Response ? result : NextResponse.json({ job: result }, { status: 202, headers });
}
const controlSchema = z.object({ id: z.string().min(1).max(200), action: z.enum(["retry", "dismiss"]) }).strict();
export async function PATCH(request: Request) {
 const env = getEnv(), { user, error } = await requireSessionUser(env, request);if (error) return error;
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 const input = controlSchema.safeParse(await readJsonBody(request, 4096).catch(() => null));
 if (!input.success) return NextResponse.json({ error: "Invalid job control" }, { status: 400 });
 const job = await controlBulkJob(env, user.id, input.data.id, input.data.action);
 if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
 return NextResponse.json({ job }, { headers });
}
