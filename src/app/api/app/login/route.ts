import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { appLoginSchema } from "@/lib/validators";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { createLoginChallenge } from "@/lib/auth/login-challenge";
import { finishAppSignIn, isAppSignInAllowed } from "@/lib/auth/device-session";

/** Sign-in for an installed app: answers with a device session token and never sets a cookie. */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid login request" }, { status });
	}
	const parsed = appLoginSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}
	if (!(await allowLoginAttempt(env, request))) {
		return NextResponse.json(
			{ error: "Too many login attempts. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "60" } },
		);
	}
	if (!(await isAppSignInAllowed(env, request))) {
		return NextResponse.json({ error: "App sign-in requires Cloudflare Access" }, { status: 403 });
	}

	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
	if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
		return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
	}
	if (user.disabled) {
		return NextResponse.json({ error: "Account disabled" }, { status: 403 });
	}

	const headers = { "Cache-Control": "no-store" };
	if (user.totpEnabled && user.totpSecret) {
		const challengeToken = await createLoginChallenge(env, user.id);
		return NextResponse.json({ ok: true, mfaRequired: true, challengeToken }, { headers });
	}
	const result = await finishAppSignIn(env, user, parsed.data.deviceName, request);
	return NextResponse.json({ ok: true, ...result }, { headers });
}
