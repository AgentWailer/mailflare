import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { listSignedInDevices } from "@/lib/auth/device-session";

/** The devices signed in to the account, for the account's owner. */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const devices = await listSignedInDevices(env, user.id, getSessionTokenFromRequestHeaders(request));
	return NextResponse.json({ devices }, { headers: { "Cache-Control": "private, no-store" } });
}
