import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { getVapidPublicKey, isSupportedPushEndpoint, sendPushTestNotification } from "@/lib/push/server";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	if (!getVapidPublicKey(env)) return Response.json({ error: "Push notifications are not configured" }, { status: 503 });
	const data = await request.json().catch(() => null) as { endpoint?: unknown } | null;
	if (typeof data?.endpoint !== "string" || data.endpoint.length > 4096 || !isSupportedPushEndpoint(data.endpoint)) {
		return Response.json({ error: "Invalid push endpoint" }, { status: 400 });
	}
	const result = await sendPushTestNotification(env, auth.user.id, data.endpoint);
	if (!result.sent) return Response.json({ error: "Push test could not be delivered", ...result }, { status: 502 });
	return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
