import { hasSignedAccessAssertion } from "@/lib/mcp/access-identity";
import { recordAuthActivity } from "./activity";
import { createDeviceSession } from "./session";
import type { AppSignInResult, AppSignInUser } from "./device-session-types";

/**
 * An installed app cannot solve the Turnstile challenge the web sign-in shows. Where an
 * installation uses Turnstile, the app may therefore only sign in through Cloudflare Access,
 * which stands in for it. Without Turnstile the app is treated like the web sign-in.
 *
 * Access proves the path, not the person: a device presents a service token, which has no
 * user identity. Password, second factor and the sign-in limiter still decide who gets in.
 */
export async function isAppSignInAllowed(env: CloudflareEnv, request: Request): Promise<boolean> {
	if (!env.TURNSTILE_SECRET_KEY?.trim()) return true;
	// APP_ACCESS_AUDIENCE names the Access application in front of the app's routes when it is
	// not the one MCP uses. A set but malformed value refuses every sign-in rather than fall back.
	const audience = env.APP_ACCESS_AUDIENCE?.trim();
	return hasSignedAccessAssertion(env, request, audience || undefined);
}

export async function finishAppSignIn(
	env: CloudflareEnv,
	user: AppSignInUser,
	deviceName: string,
	request: Request,
): Promise<AppSignInResult> {
	const token = await createDeviceSession(env, user.id, deviceName);
	await recordAuthActivity(env, { action: "auth.login", userId: user.id, request });
	return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}
