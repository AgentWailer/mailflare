import { getEnv } from "@/lib/cloudflare";
import { getMcpAuthentication } from "@/lib/mcp/auth";
import { createMailflareMcpHandler } from "@/lib/mcp/server";
import { allowAgentRequest } from "@/lib/agent/rate-limit";

async function handle(request: Request) {
	const url = new URL(request.url);
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
	const env = getEnv();
	if (env.APP_URL && url.host !== new URL(env.APP_URL).host) return new Response("Invalid host", { status: 403 });
	const {principal,reason} = await getMcpAuthentication(env, request);
	if (!principal && reason === "grant_required") return Response.json({error:"Enable or review your ChatGPT OAuth permissions in Mailflare Settings → API keys",settingsUrl:new URL("/settings/api-keys",env.APP_URL || url.origin).toString()},{status:403,headers:{"Cache-Control":"private, no-store"}});
	if (!principal) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "private, no-store" } });
	if (!await allowAgentRequest(env, `mcp:${principal.keyId}`)) return new Response("Rate limit exceeded", { status: 429 });
	const handler = createMailflareMcpHandler(env, principal, url.origin, request.headers.get("Authorization") ?? "");
	try {
		const response = await handler.fetch(request);
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "private, no-store");
		headers.append("Vary", "Authorization, Cookie, Cf-Access-Jwt-Assertion");
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
	finally { await handler.close(); }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
