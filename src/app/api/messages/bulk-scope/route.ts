import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { bulkScopeSchema, executeBulkScope } from "@/lib/messages/bulk-scope";

export async function POST(request: Request) {
 const env = getEnv(), { user, error } = await requireSessionUser(env, request);
 if (error) return error;
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 const input = bulkScopeSchema.safeParse(await readJsonBody(request, 16384).catch(() => null));
 if (!input.success) return NextResponse.json({ error: "Invalid bulk selection scope" }, { status: 400 });
 return executeBulkScope(env, user, input.data);
}
