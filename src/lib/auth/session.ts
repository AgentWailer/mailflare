import { and, eq, gt, ne, getTableColumns } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { getDb } from "@/db";
import { deviceSessions, sessions, users } from "@/db/schema";
import { getExplicitSessionToken } from "./session-header";

export const SESSION_COOKIE = "ep_session";
const SESSION_DAYS = 30;
/** An installed app stays signed in while it is used: 90 days, renewed at most once a week. */
const DEVICE_SESSION_DAYS = 90;
const DEVICE_SESSION_RENEW_BELOW_DAYS = 83;
const DEVICE_TOKEN_PREFIX = "dev_";
const DAY_MS = 86_400_000;

export function generateSessionToken(): string {
	return newId("sess");
}

export async function hashSessionToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function createSession(env: CloudflareEnv, userId: string): Promise<string> {
	const db = getDb(env);
	const token = generateSessionToken();
	const tokenHash = await hashSessionToken(token);
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

	await db.insert(sessions).values({
		id: newId(),
		userId,
		tokenHash,
		expiresAt,
	});

	return token;
}

/**
 * A session for an installed app. Its token starts with `dev_`, which is how a request is
 * recognised as coming from a device without reading anything but the `sessions` row.
 */
export async function createDeviceSession(env: CloudflareEnv, userId: string, deviceName: string): Promise<string> {
	const db = getDb(env);
	const token = newId("dev");
	const id = newId();
	await db.batch([
		db.insert(sessions).values({
			id,
			userId,
			tokenHash: await hashSessionToken(token),
			expiresAt: new Date(Date.now() + DEVICE_SESSION_DAYS * DAY_MS),
		}),
		db.insert(deviceSessions).values({ sessionId: id, deviceName }),
	]);
	return token;
}

async function renewDeviceSession(
	env: CloudflareEnv,
	token: string,
	session: { id: string; expiresAt: Date },
): Promise<void> {
	if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return;
	const now = Date.now();
	if (session.expiresAt.getTime() - now >= DEVICE_SESSION_RENEW_BELOW_DAYS * DAY_MS) return;
	try {
		const db = getDb(env);
		await db.batch([
			db.update(sessions).set({ expiresAt: new Date(now + DEVICE_SESSION_DAYS * DAY_MS) }).where(eq(sessions.id, session.id)),
			db.update(deviceSessions).set({ lastUsedAt: new Date(now) }).where(eq(deviceSessions.sessionId, session.id)),
		]);
	} catch (error) {
		// The request is authenticated either way; a missed renewal is retried on the next one.
		console.warn("Device session renewal failed", error);
	}
}

export async function getUserFromSession(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof users.$inferSelect | null> {
	if (!token) return null;
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	// Check live session validity and load the user in one database round trip.
	const [row] = await db.select({
		user: getTableColumns(users),
		session: { id: sessions.id, expiresAt: sessions.expiresAt },
	}).from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
		.limit(1);
	if (!row) return null;
	await renewDeviceSession(env, token, row.session);
	return row.user;
}

export async function getSessionFromToken(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof sessions.$inferSelect | null> {
	if (!token) return null;
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
		.limit(1);
	if (session) await renewDeviceSession(env, token, session);
	return session ?? null;
}

export async function deleteSession(env: CloudflareEnv, token: string): Promise<void> {
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Sign the user out everywhere, optionally keeping the session that made the
 * request. Used after a password change or reset and when MFA is switched on.
 */
export async function deleteUserSessions(env: CloudflareEnv, userId: string, keepToken?: string): Promise<void> {
	const db = getDb(env);
	if (keepToken) {
		const keepHash = await hashSessionToken(keepToken);
		await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepHash)));
		return;
	}
	await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** The session token a request carries: the app's header, a bearer token, or the cookie. */
export function getSessionTokenFromRequestHeaders(request: Request): string | undefined {
	const explicit = getExplicitSessionToken(request);
	if (explicit) return explicit;
	const cookie = request.headers.get("Cookie") ?? "";
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
	return match ? decodeURIComponent(match[1]) : undefined;
}
