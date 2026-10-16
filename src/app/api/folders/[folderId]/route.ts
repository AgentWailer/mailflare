import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { folders } from "@/db/schema";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getFolderForMailbox, getMailboxFolderAccess } from "../utils";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonBody } from "@/lib/http/request";

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

const patchSchema = z.object({ mailboxId: z.string().min(1).max(128), parentId: z.string().min(1).max(128).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), name: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f]+$/).optional() }).strict().refine(input => input.parentId !== undefined || input.name !== undefined || input.color !== undefined);

/** Rename, recolor or change hierarchy; labels on messages and filter targets keep their IDs. */
export async function PATCH(request: Request, context: { params: Promise<{ folderId: string }> }) {
 const env = getEnv();
 const { user, error } = await requireSessionUser(env, request);
 if (error) return error;
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 const parsed = patchSchema.safeParse(await readJsonBody(request, 4096).catch(() => null));
 if (!parsed.success) return NextResponse.json({ error: "Invalid label update" }, { status: 400 });
 const { mailboxId, parentId, name, color } = parsed.data;
 const { folderId } = await context.params;
 const db = getDb(env);
 const access = await getMailboxFolderAccess(db, user, mailboxId);
 if (!access?.canManage || !(await getFolderForMailbox(db, folderId, mailboxId)) || (parentId && !(await getFolderForMailbox(db, parentId, mailboxId)))) {
  return NextResponse.json({ error: "Label not found" }, { status: 404 });
 }
 if (parentId === folderId) return NextResponse.json({ error: "Label cannot contain itself" }, { status: 400 });
 try {
  // The database trigger checks the complete ancestor chain within this atomic write,
  // including concurrent moves that would otherwise create a cycle.
  const changes = { ...(parentId !== undefined ? { parentId } : {}), ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color: color.toLowerCase() } : {}) };
  const [saved] = await db.update(folders).set(changes).where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId))).returning();
  if (!saved) return NextResponse.json({ error: "Label not found" }, { status: 404 });
  return NextResponse.json({ ok: true, folder: { id: saved.id, mailboxId: saved.mailboxId, name: saved.name, parentId: saved.parentId, color: saved.color } });
 } catch (error) {
  const detail = String(error) + String((error as { cause?: unknown }).cause ?? "");
  if (detail.includes("Invalid label parent")) return NextResponse.json({ error: "Invalid label parent" }, { status: 400 });
  if (detail.includes("UNIQUE constraint")) return NextResponse.json({ error: "Folder already exists" }, { status: 409 });
  throw error;
 }
}
