import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonBody } from "@/lib/http/request";
import { readWritingPreferences, writingPreferencesSchema } from "@/lib/agent/writing-preferences";
import { getAgentProviderPublicConfig } from "@/lib/agent/provider";
import { defaultWritingModel } from "@/lib/agent/provider-constants";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
	const auth = await requireSessionUser(getEnv(), request);
	if (auth.error) return auth.error;
	const config = await getAgentProviderPublicConfig(getEnv());
	const preferences = readWritingPreferences(auth.user.writingPreferences);
	if (preferences.modelId && !config.models.includes(preferences.modelId)) preferences.modelId = null;
	return NextResponse.json({ preferences, models: config.models.map(id => ({ id, rates: config.rates[id] })), defaultModel: defaultWritingModel(config) }, { headers });
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = writingPreferencesSchema.safeParse(await readJsonBody(request, 16_384).catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Invalid writing preferences" }, { status: 400 });
	if (parsed.data.modelId && !(await getAgentProviderPublicConfig(env)).models.includes(parsed.data.modelId)) return NextResponse.json({ error: "Choose an enabled model" }, { status: 400 });
	await getDb(env).update(users).set({ writingPreferences: JSON.stringify(parsed.data) }).where(eq(users.id, auth.user.id));
	return NextResponse.json({ preferences: parsed.data }, { headers });
}
