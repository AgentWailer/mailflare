import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getFolderForMailbox, getMailboxFolderAccess, listFoldersForMailbox } from "@/app/api/folders/utils";

const visibilitySchema = z.object({ mailboxId: z.string().min(1).max(128), labelId: z.string().min(1).max(128), visible: z.boolean() }).strict();

async function readHiddenLabels(env: CloudflareEnv, userId: string, mailboxId: string) {
	const db = getDb(env);
	const [row] = await db.select({ hidden: users.hiddenLabelIds }).from(users).where(eq(users.id, userId)).limit(1);
	let saved: unknown;
	try { saved = JSON.parse(row?.hidden ?? "[]"); } catch { saved = []; }
	const ids = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
	const labels = await listFoldersForMailbox(db, mailboxId);
	return labels.filter(label => ids.has(label.id)).map(label => label.id);
}

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Mailbox required" }, { status: 400 });
	if (!(await getMailboxFolderAccess(getDb(env), user, mailboxId))) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	return NextResponse.json({ hiddenLabelIds: await readHiddenLabels(env, user.id, mailboxId) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const parsed = visibilitySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Invalid visibility settings" }, { status: 400 });
	const { mailboxId, labelId, visible } = parsed.data;
	const db = getDb(env);
	// Read-only delegates may change their own sidebar without modifying the mailbox.
	if (!(await getMailboxFolderAccess(db, user, mailboxId)) || !(await getFolderForMailbox(db, labelId, mailboxId))) {
		return NextResponse.json({ error: "Label not found" }, { status: 404 });
	}
	// Edit one ID atomically; concurrent changes to other labels are retained.
	await env.DB.prepare(`UPDATE users SET hidden_label_ids = (
		SELECT json_group_array(value) FROM (
			SELECT value FROM json_each(CASE WHEN json_valid(hidden_label_ids) THEN CASE WHEN json_type(hidden_label_ids) = 'array' THEN hidden_label_ids ELSE '[]' END ELSE '[]' END)
			WHERE type = 'text' AND value != ?
			UNION SELECT ? WHERE ? = 0
		)
	) WHERE id = ?`).bind(labelId, labelId, visible ? 1 : 0, user.id).run();
	return NextResponse.json({ hiddenLabelIds: await readHiddenLabels(env, user.id, mailboxId) }, { headers: { "Cache-Control": "private, no-store" } });
}
