import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";

const inputSchema = z.object({ enabled: z.boolean() }).strict();
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
	const auth = await requireSessionUser(getEnv(), request);
	if (auth.error) return auth.error;
	return NextResponse.json({ enabled: auth.user.allowExternalContent }, { headers });
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	let enabled: boolean;
	try { enabled = inputSchema.parse(await request.json()).enabled; }
	catch { return NextResponse.json({ error: "Invalid external content setting" }, { status: 400 }); }
	await getDb(env).update(users).set({ allowExternalContent: enabled }).where(eq(users.id, auth.user.id));
	return NextResponse.json({ enabled }, { headers });
}
