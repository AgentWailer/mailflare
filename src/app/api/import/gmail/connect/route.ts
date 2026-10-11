import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { beginGoogleAuthorization } from "@/lib/import/gmail-oauth";

export async function POST(request: Request) {
	const env = getEnv(), auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	try { return NextResponse.json({ url: await beginGoogleAuthorization(env, auth.user.id, request) }, { headers: { "Cache-Control": "private, no-store" } }); }
	catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Google connection failed" }, { status: 400 }); }
}
