import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { recordAuthActivity } from "@/lib/auth/activity";
import { endDeviceSession } from "@/lib/auth/device-session";

/** Signs one of the account's devices out, for example a lost phone. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const { id } = await params;
	if (!(await endDeviceSession(env, user.id, id))) {
		return NextResponse.json({ error: "Device not found" }, { status: 404 });
	}
	await recordAuthActivity(env, { action: "auth.device_signed_out", userId: user.id, request });
	return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
