import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMessageWithBodyForUser } from "@/lib/email/inbound";
import { requestTiming } from "@/lib/server-timing";

type MessageRouteParams = {
	params: Promise<{ messageId: string }>;
};

export async function GET(request: Request, { params }: MessageRouteParams) {
	const timing = requestTiming();
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	timing.mark("auth");

	const { messageId } = await params;
	const data = await getMessageWithBodyForUser(env, user, messageId, timing.mark);
	if (!data) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	return NextResponse.json(data, { headers: { ...timing.headers(), "Cache-Control": "private, no-store" } });
}
