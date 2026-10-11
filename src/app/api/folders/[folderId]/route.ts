import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getFolderForMailbox, getMailboxFolderAccess } from "../utils";

/** Remove a label and its references, never the messages or their attachments. */
export async function DELETE(request: Request, context: { params: Promise<{ folderId: string }> }) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Mailbox required" }, { status: 400 });
	const { folderId } = await context.params;
	const db = getDb(env);
	const access = await getMailboxFolderAccess(db, user, mailboxId);
	if (!access?.canManage || !(await getFolderForMailbox(db, folderId, mailboxId))) {
		return NextResponse.json({ error: "Label not found" }, { status: 404 });
	}

	// A batch is transactional in both D1 and the local SQLite runtime. Filter cleanup
	// happens in SQL so a concurrent filter edit cannot be overwritten by a stale snapshot.
	await env.DB.batch([
		env.DB.prepare(`UPDATE routing_rules SET
			label_ids = (SELECT json_group_array(value) FROM json_each(
				CASE WHEN json_valid(label_ids) THEN label_ids ELSE '[]' END) WHERE value != ?),
			folder_id = CASE WHEN folder_id = ? THEN NULL ELSE folder_id END
			WHERE mailbox_id = ? AND (folder_id = ? OR EXISTS (SELECT 1 FROM json_each(
				CASE WHEN json_valid(label_ids) THEN label_ids ELSE '[]' END) WHERE value = ?))`).bind(folderId, folderId, mailboxId, folderId, folderId),
		env.DB.prepare(`UPDATE messages SET folder_id = NULL,
			status = CASE WHEN status = 'received' AND category = 'primary' THEN 'archived' ELSE status END
			WHERE folder_id = ? AND mailbox_id = ?`).bind(folderId, mailboxId),
		env.DB.prepare(`DELETE FROM message_labels WHERE folder_id = ?`).bind(folderId),
		env.DB.prepare(`DELETE FROM folders WHERE id = ? AND mailbox_id = ?`).bind(folderId, mailboxId),
	]);
	return NextResponse.json({ ok: true });
}
