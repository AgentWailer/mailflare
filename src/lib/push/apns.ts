import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appDevices, deviceSessions, messages, sessions, users } from "@/db/schema";
import { hashSessionToken } from "@/lib/auth/session";
import { shouldNotifyMail } from "@/lib/mail-sorting/categories";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { NewMessageNotification } from "@/lib/realtime/types";
import { getUnreadBadgeCount } from "./badge";
import { buildMailPushContent } from "./notification-content";

type ApnsConfig = { key: string; keyId: string; teamId: string; bundleId: string };
export type ApnsEnvironment = "production" | "sandbox";

const HOSTS: Record<ApnsEnvironment, string> = {
	production: "api.push.apple.com",
	sandbox: "api.sandbox.push.apple.com",
};
/** Reasons with which Apple says a token will never work again for this app. */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
/** Apple refuses a provider token older than an hour and one renewed more often than every 20 minutes. */
const PROVIDER_TOKEN_LIFETIME_MS = 45 * 60_000;

let cachedProviderToken: { for: string; value: string; createdAt: number } | null = null;

export function resetApnsTokenCache() {
	cachedProviderToken = null;
}

function parseApnsConfig(env: CloudflareEnv): ApnsConfig | null {
	const key = env.APNS_KEY?.trim();
	const keyId = env.APNS_KEY_ID?.trim();
	const teamId = env.APNS_TEAM_ID?.trim();
	const bundleId = env.APNS_BUNDLE_ID?.trim();
	return key && keyId && teamId && bundleId ? { key, keyId, teamId, bundleId } : null;
}

export function isApnsConfigured(env: CloudflareEnv): boolean {
	return parseApnsConfig(env) !== null;
}

function base64Url(value: Uint8Array | string): string {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function providerToken(config: ApnsConfig): Promise<string> {
	const owner = `${config.teamId}:${config.keyId}`;
	if (cachedProviderToken && cachedProviderToken.for === owner && Date.now() - cachedProviderToken.createdAt < PROVIDER_TOKEN_LIFETIME_MS) {
		return cachedProviderToken.value;
	}
	// The secret may hold the .p8 file as it is, or with its line breaks written as \n.
	const pem = config.key.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(pem), (character) => character.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const unsigned = `${base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }))}.${base64Url(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }))}`;
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
	const value = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
	cachedProviderToken = { for: owner, value, createdAt: Date.now() };
	return value;
}

/**
 * Tells the installed apps of these users about a new message, through Apple. Applies what the
 * web push applies: a session that still holds, an active user, the right to read the mailbox
 * now, and mail that is worth a notification. Without an Apple key it does nothing at all, so
 * an installation that has not applied the app's migration is not asked for its table.
 */
export async function sendAppNotifications(
	env: CloudflareEnv,
	userIds: string[],
	payload: NewMessageNotification,
): Promise<{ sent: number; failed: number }> {
	const result = { sent: 0, failed: 0 };
	const config = parseApnsConfig(env);
	const uniqueUserIds = [...new Set(userIds)];
	if (!config || uniqueUserIds.length === 0 || payload.silent) return result;
	try {
		const db = getDb(env);
		const [message] = await db.select({
			status: messages.status, folderId: messages.folderId, category: messages.category, read: messages.read,
			snoozedUntil: messages.snoozedUntil, snippet: messages.snippet, threadId: messages.threadId,
			text: sql<string | null>`substr(${messages.textBody}, 1, 16384)`,
			html: sql<string | null>`substr(${messages.htmlBody}, 1, 65536)`,
		}).from(messages).where(and(eq(messages.id, payload.messageId), eq(messages.mailboxId, payload.mailboxId))).limit(1);
		if (!message || !shouldNotifyMail(message) || (message.snoozedUntil && message.snoozedUntil > new Date())) return result;

		const devices = await db
			.select({ sessionId: appDevices.sessionId, token: appDevices.token, environment: appDevices.environment, user: users })
			.from(appDevices)
			.innerJoin(sessions, eq(appDevices.sessionId, sessions.id))
			.innerJoin(users, eq(sessions.userId, users.id))
			.where(and(
				inArray(appDevices.userId, uniqueUserIds),
				eq(appDevices.userId, users.id),
				gt(sessions.expiresAt, new Date()),
				eq(users.disabled, false),
			));
		if (devices.length === 0) return result;

		const content = buildMailPushContent({ ...payload, snippet: message.snippet, text: message.text, html: message.html });
		// The web shows subject and preview as one text; iOS has a line of its own for the subject.
		const [subject, ...preview] = content.body.split("\n");
		const alert = preview.length > 0
			? { title: content.title, subtitle: subject, body: preview.join("\n") }
			: { title: content.title, body: subject };
		const authorization = `bearer ${await providerToken(config)}`;
		const unreadCounts = new Map<string, Promise<number>>();

		await Promise.allSettled(devices.map(async (device) => {
			try {
				if (!(await getMailboxAccessLevel(db, device.user, payload.mailboxId))?.canRead) return;
				let unread = unreadCounts.get(device.user.id);
				if (!unread) {
					unread = getUnreadBadgeCount(db, device.user);
					unreadCounts.set(device.user.id, unread);
				}
				const host = HOSTS[device.environment === "sandbox" ? "sandbox" : "production"];
				const response = await fetch(`https://${host}/3/device/${device.token}`, {
					method: "POST",
					headers: {
						authorization,
						"apns-topic": config.bundleId,
						"apns-push-type": "alert",
						"apns-priority": "10",
						// A newer notification about the same message replaces the older one.
						"apns-collapse-id": payload.messageId,
						// Apple keeps it for a phone that is off for up to a day.
						"apns-expiration": String(Math.floor(Date.now() / 1000) + 86_400),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						aps: {
							alert,
							badge: await unread,
							sound: "default",
							"thread-id": message.threadId ?? payload.messageId,
							category: "MAIL",
							// Wakes the app so the message is on the phone when the notification is tapped.
							"content-available": 1,
						},
						messageId: payload.messageId,
						mailboxId: payload.mailboxId,
						userId: device.user.id,
					}),
				});
				if (response.ok) {
					result.sent++;
					return;
				}
				result.failed++;
				const reason = await response.json().then((body) => (body as { reason?: string }).reason, () => undefined);
				if (response.status === 410 || (reason && DEAD_TOKEN_REASONS.has(reason))) {
					await db.delete(appDevices).where(and(eq(appDevices.sessionId, device.sessionId), eq(appDevices.token, device.token)));
				} else {
					console.warn(`Apple push delivery failed (${response.status}${reason ? ` ${reason}` : ""}) for a device of user ${device.user.id}`);
				}
			} catch (error) {
				result.failed++;
				console.warn(`Apple push delivery failed for a device of user ${device.user.id}`, error);
			}
		}));
	} catch (error) {
		// Never the mail pipeline's problem: a missing table or key error is said and left.
		// The cause is the short part; a query error's own text repeats the whole statement.
		const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
		console.warn("Apple push delivery could not run:", cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200));
	}
	return result;
}

/** The device session behind a session token, or null for a browser's session. */
async function findDeviceSession(env: CloudflareEnv, sessionToken: string): Promise<{ sessionId: string; userId: string } | null> {
	const [row] = await getDb(env)
		.select({ sessionId: sessions.id, userId: sessions.userId })
		.from(sessions)
		.innerJoin(deviceSessions, eq(deviceSessions.sessionId, sessions.id))
		.where(and(eq(sessions.tokenHash, await hashSessionToken(sessionToken)), gt(sessions.expiresAt, new Date())))
		.limit(1);
	return row ?? null;
}

/** Stores the address Apple gave the app of this session. False for a session that is no app's. */
export async function registerAppDevice(env: CloudflareEnv, sessionToken: string, token: string, environment: ApnsEnvironment): Promise<boolean> {
	const device = await findDeviceSession(env, sessionToken);
	if (!device) return false;
	const db = getDb(env);
	const now = new Date();
	await db.batch([
		// The same phone under an older session of the same account, as after reinstalling the
		// app, would be notified twice. Another account on the same phone keeps its entry.
		db.delete(appDevices).where(and(eq(appDevices.token, token), eq(appDevices.userId, device.userId), ne(appDevices.sessionId, device.sessionId))),
		db.insert(appDevices)
			.values({ sessionId: device.sessionId, userId: device.userId, token, environment, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({ target: appDevices.sessionId, set: { token, environment, userId: device.userId, updatedAt: now } }),
	]);
	return true;
}

export async function unregisterAppDevice(env: CloudflareEnv, sessionToken: string): Promise<void> {
	const device = await findDeviceSession(env, sessionToken);
	if (device) await getDb(env).delete(appDevices).where(eq(appDevices.sessionId, device.sessionId));
}
