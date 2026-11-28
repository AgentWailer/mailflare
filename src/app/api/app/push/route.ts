import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { isApnsConfigured, registerAppDevice, unregisterAppDevice } from "@/lib/push/apns";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** The installed app hands over the address Apple gave it, so new mail can be announced on it. */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!user || !sessionToken) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = await request.json().catch(() => null) as { token?: unknown; environment?: unknown } | null;
	const token = typeof body?.token === "string" ? body.token.trim().toLowerCase() : "";
	const environment = body?.environment;
	if (!/^[0-9a-f]{64,512}$/.test(token) || token.length % 2 !== 0 || (environment !== "production" && environment !== "sandbox")) {
		return NextResponse.json({ error: "Invalid device token" }, { status: 400 });
	}
	if (!(await registerAppDevice(env, sessionToken, token, environment))) {
		return NextResponse.json({ error: "Only an installed app can register for notifications" }, { status: 403 });
	}
	// `configured` tells the app whether this installation can reach Apple at all.
	return NextResponse.json({ ok: true, configured: isApnsConfigured(env) }, noStore);
}

/** The app no longer wants notifications on this device. */
export async function DELETE(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!user || !sessionToken) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	await unregisterAppDevice(env, sessionToken);
	return NextResponse.json({ ok: true }, noStore);
}
