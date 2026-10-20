import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMessageThreadForUser, ThreadBodyLimitError } from "@/lib/email/thread-view";

type MessageRouteParams = {
	params: Promise<{ messageId: string }>;
};

/** Conversation headers, oldest first; bodies load separately when expanded. */
export async function GET(request: Request, { params }: MessageRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { messageId } = await params;
	let data;
	try { data = await getMessageThreadForUser(env, user, messageId, new URL(request.url).searchParams.get("view") !== "headers"); }
	catch (error) {
		if (error instanceof ThreadBodyLimitError) return NextResponse.json({ error: error.message }, { status: 413 });
		throw error;
	}
	if (!data) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	return NextResponse.json(data);
}
