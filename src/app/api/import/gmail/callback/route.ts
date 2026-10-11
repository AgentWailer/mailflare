import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { completeGoogleAuthorization, gmailConfiguration } from "@/lib/import/gmail-oauth";

export async function GET(request: Request) {
	const env = getEnv(), auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const config = gmailConfiguration(env);
	if (!config.configured || new URL(request.url).origin !== new URL(config.redirectUri!).origin) return NextResponse.json({ error: "Invalid Google callback configuration" }, { status: 400 });
	let result = "error";
	let connectionId: string | undefined;
	try { const connection = await completeGoogleAuthorization(env, auth.user.id, request); connectionId = connection.id; result = "connected"; } catch { /* Never echo authorization codes or token responses. */ }
	const target = new URL(`/settings/import?gmail=${result}`, config.redirectUri!);
	if (connectionId) target.searchParams.set("googleConnection", connectionId);
	const response = NextResponse.redirect(target, 303);
	response.headers.set("Cache-Control", "private, no-store"); response.headers.set("Referrer-Policy", "no-referrer");
	return response;
}
