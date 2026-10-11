import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getUnreadBadgeCount } from "@/lib/push/badge";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return Response.json({ unreadCount: await getUnreadBadgeCount(getDb(env), auth.user) }, {
		headers: { "Cache-Control": "private, no-store" },
	});
}
