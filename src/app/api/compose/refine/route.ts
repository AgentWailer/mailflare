import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { agentProviderErrorMessage } from "@/lib/agent/errors";
import { refineSchema } from "@/lib/agent/refine-input";
import { refineEmail, RefineError } from "@/lib/agent/refine";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ code: "unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ code: "forbidden" }, { status: 403 });
	if (!await allowAgentRequest(env, `chat:${user.id}`)) return Response.json({ code: "rate_limit" }, { status: 429 });
	let body: unknown;
	try { body = await readJsonBody(request, 80_000); }
	catch (error) { return Response.json({ code: error instanceof RequestBodyTooLargeError ? "too_long" : "invalid_request" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }); }
	const parsed = refineSchema.safeParse(body);
	if (!parsed.success) return Response.json({ code: "invalid_request" }, { status: 400 });
	try {
		const text = await refineEmail(env, user, parsed.data, request.signal);
		return Response.json({ text }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof RefineError) return Response.json({ code: error.code }, { status: error.status });
		return Response.json({ code: "provider_error", error: agentProviderErrorMessage(error) }, { status: 502 });
	}
}
