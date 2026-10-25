import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailImportConnections, gmailOauthStates } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getSessionTokenFromRequestHeaders, hashSessionToken } from "@/lib/auth/session";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export type GoogleTokens = { access_token: string; refresh_token: string; expiresAt: number };
export type GmailConnection = typeof gmailImportConnections.$inferSelect;
export class GmailError extends Error {
	constructor(public status: number, message = "Google request failed. Check Gmail API access or reconnect Google.", public retryable = false) { super(message); }
}
export function encodeBase64(bytes: Uint8Array) {
	let value = ""; for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value);
}
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
	let length = value.length; while (value[length - 1] === "=") length--;
	if (length % 4 === 1) throw new Error("Invalid Google message encoding");
	const result = new Uint8Array(Math.floor(length * 3 / 4));
	let offset = 0;
	for (let i = 0; i < value.length; i += 65536) {
		const part = value.slice(i, i + 65536).replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(part); for (let j = 0; j < binary.length; j++) result[offset++] = binary.charCodeAt(j);
	}
	return result;
}
const urlBase64 = (bytes: Uint8Array) => encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function gmailConfiguration(env: CloudflareEnv) {
	const required = ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REDIRECT_URI", "GMAIL_IMPORT_ENCRYPTION_KEY"] as const;
	const missing: string[] = required.filter(name => typeof env[name] !== "string" || !env[name]?.trim());
	try { if (env.GMAIL_IMPORT_ENCRYPTION_KEY && decodeBase64(env.GMAIL_IMPORT_ENCRYPTION_KEY).length !== 32) missing.push("GMAIL_IMPORT_ENCRYPTION_KEY (32 bytes)"); } catch { missing.push("GMAIL_IMPORT_ENCRYPTION_KEY (invalid)"); }
	try { const url = new URL(env.GMAIL_OAUTH_REDIRECT_URI!); if (url.protocol !== "https:" || url.pathname !== "/api/import/gmail/callback" || url.search || url.hash) missing.push("GMAIL_OAUTH_REDIRECT_URI (HTTPS callback)"); } catch { if (env.GMAIL_OAUTH_REDIRECT_URI) missing.push("GMAIL_OAUTH_REDIRECT_URI (invalid)"); }
	return { configured: missing.length === 0, missing, redirectUri: env.GMAIL_OAUTH_REDIRECT_URI ?? null };
}
function configuration(env: CloudflareEnv) {
	if (!gmailConfiguration(env).configured) throw new Error("Google import is not configured on this server");
	return { clientId: env.GMAIL_OAUTH_CLIENT_ID!.trim(), secret: env.GMAIL_OAUTH_CLIENT_SECRET!.trim(), redirectUri: env.GMAIL_OAUTH_REDIRECT_URI!.trim() };
}
async function key(env: CloudflareEnv) {
	if (!env.GMAIL_IMPORT_ENCRYPTION_KEY) throw new Error("Google token encryption is not configured");
	return crypto.subtle.importKey("raw", decodeBase64(env.GMAIL_IMPORT_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptGoogleTokens(env: CloudflareEnv, binding: string, tokens: GoogleTokens) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(binding) }, await key(env), new TextEncoder().encode(JSON.stringify(tokens)));
	return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(encrypted))}`;
}
export async function decryptGoogleTokens(env: CloudflareEnv, binding: string, stored: string): Promise<GoogleTokens> {
	const [version, iv, value] = stored.split("."); if (version !== "v1" || !iv || !value) throw new Error("Reconnect Google to restore its authorization");
	try {
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(iv), additionalData: new TextEncoder().encode(binding) }, await key(env), decodeBase64(value));
		const tokens = JSON.parse(new TextDecoder().decode(plain)) as GoogleTokens;
		if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expiresAt)) throw new Error("Invalid tokens");
		return tokens;
	} catch { throw new Error("Reconnect Google to restore its authorization"); }
}
export async function beginGoogleAuthorization(env: CloudflareEnv, userId: string, request: Request) {
	const config = configuration(env);
	if (new URL(request.url).origin !== new URL(config.redirectUri).origin) throw new Error("Open Mailflare at its configured Google callback origin");
	const session = getSessionTokenFromRequestHeaders(request); if (!session) throw new Error("Session required");
	const state = urlBase64(crypto.getRandomValues(new Uint8Array(32)));
	const verifier = urlBase64(crypto.getRandomValues(new Uint8Array(32)));
	const db = getDb(env);
	await db.delete(gmailOauthStates).where(lt(gmailOauthStates.expiresAt, Date.now()));
	await db.insert(gmailOauthStates).values({ id: await hashSessionToken(state), userId, sessionHash: await hashSessionToken(session), verifier, expiresAt: Date.now() + 15 * 60_000 });
	const challenge = urlBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: "consent select_account", state, code_challenge: challenge, code_challenge_method: "S256" });
	return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
async function tokenRequest(env: CloudflareEnv, fields: Record<string, string>) {
	const config = configuration(env);
	const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, client_id: config.clientId, client_secret: config.secret }), signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new GmailError(response.status, "Google authorization expired or was denied. Reconnect Google.");
	const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
	if (!data.access_token || !data.expires_in) throw new Error("Google returned an incomplete authorization");
	return data;
}
export async function completeGoogleAuthorization(env: CloudflareEnv, userId: string, request: Request) {
	const config = configuration(env), url = new URL(request.url);
	if (url.origin !== new URL(config.redirectUri).origin) throw new Error("Invalid callback origin");
	const state = url.searchParams.get("state"), session = getSessionTokenFromRequestHeaders(request);
	if (!state || !session) throw new Error("Invalid Google authorization state");
	const db = getDb(env);
	const [stored] = await db.delete(gmailOauthStates).where(and(eq(gmailOauthStates.id, await hashSessionToken(state)), eq(gmailOauthStates.userId, userId), eq(gmailOauthStates.sessionHash, await hashSessionToken(session)), gt(gmailOauthStates.expiresAt, Date.now()))).returning();
	if (!stored) throw new Error("Google authorization state expired or was already used");
	const code = url.searchParams.get("code"); if (!code || url.searchParams.has("error")) throw new Error("Google authorization was cancelled");
	const tokens = await tokenRequest(env, { code, code_verifier: stored.verifier, redirect_uri: config.redirectUri, grant_type: "authorization_code" });
	if (!tokens.scope?.split(" ").includes(GMAIL_SCOPE) || !tokens.refresh_token) throw new Error("Google did not grant offline Gmail read access");
	const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new GmailError(response.status);
	const profile = await response.json() as { emailAddress?: string };
	if (!profile.emailAddress?.includes("@")) throw new Error("Google did not return a Gmail account");
	const email = profile.emailAddress.toLowerCase();
	const [existing] = await db.select().from(gmailImportConnections).where(and(eq(gmailImportConnections.userId, userId), eq(gmailImportConnections.email, email))).limit(1);
	const id = existing?.id ?? newId("google");
	const encrypted = await encryptGoogleTokens(env, `${userId}:${id}`, { access_token: tokens.access_token!, refresh_token: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in! * 1000 });
	if (existing) await db.update(gmailImportConnections).set({ tokens: encrypted }).where(eq(gmailImportConnections.id, id));
	else await db.insert(gmailImportConnections).values({ id, userId, email, tokens: encrypted });
	return { id, email };
}
export async function gmailRequest<T>(env: CloudflareEnv, connection: GmailConnection, path: string): Promise<T> {
	configuration(env);
	if (!path.startsWith("/")) throw new Error("Invalid Gmail API path");
	let tokens = await decryptGoogleTokens(env, `${connection.userId}:${connection.id}`, connection.tokens);
	async function refresh() {
		const updated = await tokenRequest(env, { refresh_token: tokens.refresh_token, grant_type: "refresh_token" });
		tokens = { access_token: updated.access_token!, refresh_token: updated.refresh_token ?? tokens.refresh_token, expiresAt: Date.now() + updated.expires_in! * 1000 };
		connection.tokens = await encryptGoogleTokens(env, `${connection.userId}:${connection.id}`, tokens);
		await getDb(env).update(gmailImportConnections).set({ tokens: connection.tokens }).where(and(eq(gmailImportConnections.id, connection.id), eq(gmailImportConnections.userId, connection.userId)));
	}
	if (tokens.expiresAt < Date.now() + 60_000) await refresh();
	let response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: "error", signal: AbortSignal.timeout(60_000) });
	if (response.status === 401) { await refresh(); response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: "error", signal: AbortSignal.timeout(60_000) }); }
	if (!response.ok) {
		const error = await response.json().catch(() => null) as { error?: { errors?: { reason?: string }[] } } | null;
		const limited = response.status === 429 || response.status === 403 && !!error?.error?.errors?.some(item => ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(item.reason ?? ""));
		throw new GmailError(response.status, limited ? "Google rate limit reached. Wait and resume the import." : undefined, limited);
	}
	return await response.json() as T;
}
