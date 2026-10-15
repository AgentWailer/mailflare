import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { backups } from "@/db/schema";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { CURRENT_RESCUE_KEY } from "@/lib/backups/rescue-storage";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertPrimaryAdmin(user);
		const { id } = await params;
		const [backup] = await getDb(env).select().from(backups).where(eq(backups.id, id)).limit(1);
		if (backup?.status !== "completed" || !backup.r2Key) return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
		const object = backup.kind === "rescue" ? await env.RESCUE_BUCKET?.get(CURRENT_RESCUE_KEY) : await env.BUCKET.get(backup.r2Key);
		if (!object) return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
		const descriptor = backup.kind === "rescue" ? await object.text() : null;
		if (descriptor && (JSON.parse(descriptor) as {backupId?:string}).backupId !== id) return NextResponse.json({error:"This rescue point has been replaced."},{status:404});
		return new Response(descriptor ?? object.body, {
			headers: {
				"Content-Type": "application/json",
				"Content-Disposition": `attachment; filename="${backup.filename ?? `${backup.id}.json`}"`,
				"Content-Length": String(descriptor ? new TextEncoder().encode(descriptor).byteLength : object.size),
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}
