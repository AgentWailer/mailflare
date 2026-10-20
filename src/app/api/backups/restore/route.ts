import { readFormDataBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { NextResponse } from "next/server";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { restoreDatabaseRecords } from "@/lib/backups/export";
import { getEnv } from "@/lib/cloudflare";

export async function POST(request: Request) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertPrimaryAdmin(user);
		const form = await readFormDataBody(request, 20 * 1024 * 1024);
		const file = form.get("backup");
		if (!(file instanceof File)) return NextResponse.json({ error: "Choose a backup file" }, { status: 400 });
		if (file.size > 10 * 1024 * 1024) return NextResponse.json({error:"Use the streaming recovery tools for large backups."},{status:413});
		await restoreDatabaseRecords(env.DB, await file.arrayBuffer());
		return NextResponse.json({ ok: true });
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) return NextResponse.json({error:"Use the streaming recovery tools for large backups."},{status:413});
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
