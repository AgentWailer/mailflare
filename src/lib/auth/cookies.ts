import { cookies } from "next/headers";
import { hasValidSessionMutationOrigin } from "./origin";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";

function getBearerToken(request?: Request): string | undefined {
	const authorization = request?.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return undefined;
	const token = authorization.slice(7).trim();
	return token || undefined;
}

/** Shared authentication boundary, including cookie CSRF checks for legacy routes. */
export async function resolveCurrentUser(env: CloudflareEnv, request?: Request) {
	const bearerToken = getBearerToken(request);
	const token = bearerToken ?? (await cookies()).get(SESSION_COOKIE)?.value;
	if (!token) return { user: null, failure: "unauthorized" } as const;
	// Bearer tokens are explicitly supplied; browsers attach cookies automatically.
	if (!bearerToken && request && !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) && !hasValidSessionMutationOrigin(request)) {
		return { user: null, failure: "origin" } as const;
	}
	const user = await getUserFromSession(env, token);
	if (!user || user.disabled) return { user: null, failure: "unauthorized" } as const;
	return { user, failure: null } as const;
}

export async function getCurrentUser(env: CloudflareEnv, request?: Request) {
	return (await resolveCurrentUser(env, request)).user;
}

export async function requireUser(env: CloudflareEnv, request?: Request) {
	const user = await getCurrentUser(env, request);
	if (!user) throw new Error("Unauthorized");
	return user;
}
