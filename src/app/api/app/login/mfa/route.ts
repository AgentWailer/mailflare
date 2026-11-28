import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { appMfaVerifySchema } from "@/lib/validators";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { recordAuthActivity } from "@/lib/auth/activity";
import { consumeLoginChallenge, getLoginChallengeUserId } from "@/lib/auth/login-challenge";
import { verifySecondFactor } from "@/lib/auth/mfa";
import { finishAppSignIn, isAppSignInAllowed } from "@/lib/auth/device-session";

/** Second step of an app sign-in: a challenge plus a TOTP or recovery code for a device session. */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}
	const parsed = appMfaVerifySchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}
	if (!(await allowLoginAttempt(env, request))) {
		return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "Retry-After": "60" } });
	}
	if (!(await isAppSignInAllowed(env, request))) {
		return NextResponse.json({ error: "App sign-in requires Cloudflare Access" }, { status: 403 });
	}

	const userId = await getLoginChallengeUserId(env, parsed.data.challengeToken);
	if (!userId) {
		return NextResponse.json({ error: "This sign-in attempt has expired. Start again." }, { status: 401 });
	}
	const [user] = await getDb(env).select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user || user.disabled) {
		return NextResponse.json({ error: "Account disabled" }, { status: 403 });
	}
	const method = await verifySecondFactor(env, user, parsed.data.code);
	if (!method) {
		return NextResponse.json({ error: "That code did not match" }, { status: 401 });
	}

	await consumeLoginChallenge(env, parsed.data.challengeToken);
	const result = await finishAppSignIn(env, user, parsed.data.deviceName, request);
	await recordAuthActivity(env, { action: "auth.mfa_verified", userId: user.id, request });
	return NextResponse.json({ ok: true, ...result, method }, { headers: { "Cache-Control": "no-store" } });
}
