import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getQueueFailureStatus } from "@/lib/queues/failures";
import { safeErrorCategory } from "@/lib/security/logging";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
	try {
		const env = getEnv();
		const user = await getCurrentUser(env, request);
		if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
		if (!isPrimaryAdmin(user)) return Response.json({ error: "Forbidden" }, { status: 403, headers });
		return Response.json(await getQueueFailureStatus(env), { headers });
	} catch (error) {
		console.error("Queue failure status unavailable", { error: safeErrorCategory(error) });
		return Response.json({ error: "queue_status_unavailable" }, { status: 503, headers });
	}
}
