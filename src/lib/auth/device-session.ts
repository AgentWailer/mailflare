import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { deviceSessions, sessions } from "@/db/schema";
import { hasSignedAccessAssertion } from "@/lib/mcp/access-identity";
import { recordAuthActivity } from "./activity";
import { createDeviceSession, hashSessionToken } from "./session";
import type { AppSignInResult, AppSignInUser, SignedInDevice } from "./device-session-types";

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

/** The devices signed in to an account, newest first. `currentToken` marks the one asking. */
export async function listSignedInDevices(env: CloudflareEnv, userId: string, currentToken: string | undefined): Promise<SignedInDevice[]> {
	const currentHash = currentToken ? await hashSessionToken(currentToken) : null;
	const rows = await getDb(env)
		.select({
			id: sessions.id,
			tokenHash: sessions.tokenHash,
			name: deviceSessions.deviceName,
			signedInAt: deviceSessions.createdAt,
			lastUsedAt: deviceSessions.lastUsedAt,
		})
		.from(deviceSessions)
		.innerJoin(sessions, eq(sessions.id, deviceSessions.sessionId))
		.where(eq(sessions.userId, userId))
		.orderBy(desc(deviceSessions.createdAt));
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		signedInAt: row.signedInAt.toISOString(),
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		current: row.tokenHash === currentHash,
	}));
}

/** Signs one device of the account out. False when the account has no such device. */
export async function endDeviceSession(env: CloudflareEnv, userId: string, sessionId: string): Promise<boolean> {
	const db = getDb(env);
	const [device] = await db
		.select({ id: sessions.id })
		.from(deviceSessions)
		.innerJoin(sessions, eq(sessions.id, deviceSessions.sessionId))
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
		.limit(1);
	if (!device) return false;
	// Both rows go together; D1 does not promise the cascade of a foreign key it does not enforce.
	await db.batch([
		db.delete(deviceSessions).where(eq(deviceSessions.sessionId, sessionId)),
		db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))),
	]);
	return true;
}
