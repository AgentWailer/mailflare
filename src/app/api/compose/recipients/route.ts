import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getDb } from "@/db";
import { loadRecipientDirectory } from "@/lib/contacts/recipient-directory";

/**
 * The composer's ranked address book: the signed-in user's contacts and the
 * people they sent mail to. Loaded once per composer and filtered on the device,
 * so typing never waits for the network.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const recipients = await loadRecipientDirectory(getDb(env), user);
	return NextResponse.json({ recipients }, { headers: { "Cache-Control": "private, no-store" } });
}
