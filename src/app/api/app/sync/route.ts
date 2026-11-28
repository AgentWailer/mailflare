import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { syncForDevice } from "@/lib/app-sync/sync";
import { clampSyncNumber, SYNC_DEFAULT_DAYS, SYNC_DEFAULT_LIMIT, SYNC_MAX_DAYS, SYNC_MAX_LIMIT, SYNC_MIN_DAYS } from "@/lib/app-sync/cursor-utils";

/** What an installed app needs to bring its copy of the mail up to date. */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const params = new URL(request.url).searchParams;
	const result = await syncForDevice(env, user, {
		cursor: params.get("cursor") || null,
		days: clampSyncNumber(params.get("days"), SYNC_DEFAULT_DAYS, SYNC_MIN_DAYS, SYNC_MAX_DAYS),
		limit: clampSyncNumber(params.get("limit"), SYNC_DEFAULT_LIMIT, 1, SYNC_MAX_LIMIT),
	});
	return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
