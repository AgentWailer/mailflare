import { paperlessOutbox, enqueuePaperlessMessage } from "@/lib/paperless/jobs";
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createBulkAuditLogs } from "@/lib/mailboxes/audit";
import { permanentlyDeleteMessages } from "@/lib/email/permanent-delete";
import { applySpamFeedback } from "@/lib/spam/feedback";
import type { BulkMessagePayload } from "@/app/api/messages/bulk/types";
import {
	getReadValueForBulkAction,
	getStatusForBulkAction,
	isAllowedBulkMessageAction,
	isPermanentlyDeletableStatus,
} from "@/app/api/messages/bulk/utils";

import { bulkActionConditions } from "./bulk-action-conditions";
import type { SessionUser } from "@/lib/auth/types";

export async function executeBulkMessageAction(env: CloudflareEnv, user: SessionUser, payload: BulkMessagePayload): Promise<NextResponse> {
	const messageIds = payload.messageIds?.filter(Boolean) ?? [];
	if (messageIds.length === 0 || !isAllowedBulkMessageAction(payload.action)) {
		return NextResponse.json({ error: "Invalid bulk message action" }, { status: 400 });
	}

	// D1 accepts at most 100 bound parameters; reserve room for update values.
	if (messageIds.length > 80) {
		let deleted = 0, skipped = 0;
		for (let offset = 0; offset < messageIds.length; offset += 80) {
			const response = await executeBulkMessageAction(env, user, { ...payload, messageIds: messageIds.slice(offset, offset + 80) });
			if (!response.ok) return response;
			const result = await response.json() as { deleted?: number; skipped?: number };
			deleted += result.deleted ?? 0; skipped += result.skipped ?? 0;
		}
		return NextResponse.json({ ok: true, ...(payload.action === "delete" ? { deleted, skipped } : {}) });
	}

	const status = getStatusForBulkAction(payload.action);
	const read = getReadValueForBulkAction(payload.action);
	const db = getDb(env);
	let folderId: string | null | undefined;
	let targetMailboxId: string | undefined;

	if (payload.action === "folder") {
		if (!payload.folderId) {
			return NextResponse.json({ error: "Folder is required" }, { status: 400 });
		}
		const [folder] = await db
			.select({ id: folders.id, mailboxId: folders.mailboxId })
			.from(folders)
			.where(eq(folders.id, payload.folderId))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		const folderAccess = await getMailboxAccessLevel(db, user, folder.mailboxId);
		if (!folderAccess?.canManage) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		folderId = folder.id;
		targetMailboxId = folder.mailboxId;
	} else if (payload.action === "spam" || payload.action === "trash" || payload.action === "inbox" || payload.action === "archive") {
		folderId = null;
	}

	const values = {
		...(status ? { status } : {}),
		...(read !== null ? { read } : {}),
		...(folderId !== undefined ? { folderId } : {}),
		...(payload.action === "inbox" ? {category:"primary" as const,sortingDecision:JSON.stringify({category:"primary",source:"manual",reason:"inbox_action"})} : {}),
	};

	if (payload.action !== "delete" && Object.keys(values).length === 0) {
		return NextResponse.json({ error: "No changes requested" }, { status: 400 });
	}

	const selectedMessages = await db.select({ id: messages.id, mailboxId: messages.mailboxId, status: messages.status, read: messages.read, rawR2Key: messages.rawR2Key }).from(messages).where(inArray(messages.id, messageIds));
	const allowedMessageIds: string[] = [];

	const accessByMailbox = new Map<string, Awaited<ReturnType<typeof getMailboxAccessLevel>>>();
	for (const message of selectedMessages) {
		if (!message.mailboxId || (targetMailboxId && message.mailboxId !== targetMailboxId)) continue;
		if (!accessByMailbox.has(message.mailboxId)) accessByMailbox.set(message.mailboxId, await getMailboxAccessLevel(db, user, message.mailboxId));
		const access = accessByMailbox.get(message.mailboxId);
		const canUpdate = payload.action === "read" || payload.action === "unread" ? access?.canRead : access?.canManage;
		if (!canUpdate) continue;
		allowedMessageIds.push(message.id);
	}

	if (allowedMessageIds.length === 0) {
		return NextResponse.json({ error: "No accessible messages" }, { status: 404 });
	}
	if (payload.action === "delete") {
		// Only mail already in Trash or Spam can be destroyed; anything else is skipped.
		const deletable = selectedMessages.filter(
			(message) => allowedMessageIds.includes(message.id) && isPermanentlyDeletableStatus(message.status),
		);
		const deleted = await permanentlyDeleteMessages(env, db, user.id, deletable, "bulk");
		return NextResponse.json({ ok: true, deleted, skipped: allowedMessageIds.length - deleted });
	}
	if (payload.action === "spam") {
		for (const messageId of allowedMessageIds) await applySpamFeedback(env, user, messageId, "spam");
		return NextResponse.json({ ok: true });
	}
	if (payload.action === "inbox") {
		const spamMessageIds = selectedMessages.filter((message) => message.status === "spam" && allowedMessageIds.includes(message.id)).map((message) => message.id);
		const normalMessageIds = allowedMessageIds.filter((messageId) => !spamMessageIds.includes(messageId));
		for (const messageId of spamMessageIds) await applySpamFeedback(env, user, messageId, "ham");
		if (normalMessageIds.length) await db.update(messages).set(values).where(inArray(messages.id, normalMessageIds));
		return NextResponse.json({ ok: true });
	}

	if (payload.action === "folder" && folderId && targetMailboxId) {
  const statements: D1PreparedStatement[] = [];
  for (const id of allowedMessageIds) {
   statements.push(env.DB.prepare("UPDATE messages SET folder_id=?,status='received' WHERE id=? AND mailbox_id=?").bind(folderId,id,targetMailboxId));
   statements.push(...paperlessOutbox(env,targetMailboxId,id,user.id,[folderId]));
  }
  await env.DB.batch(statements);
  await Promise.allSettled(allowedMessageIds.map(id=>enqueuePaperlessMessage(env,targetMailboxId!,id)));
  return NextResponse.json({ok:true});
 }

	// Recheck at the write boundary: saved chunks and concurrent user actions may
	// already have reached the requested state. No update means no audit/sync churn.
	const updated = await db.update(messages).set(values).where(and(
		inArray(messages.id, allowedMessageIds), ...bulkActionConditions(payload.action),
	)).returning({ id: messages.id });
	await createBulkAuditLogs(env,
		updated.map(({ id: messageId }) => ({
			actorUserId: user.id,
			messageId,
			action: payload.action === "read" || payload.action === "unread" ? "email.read" : "email.delete",
			metadata: { bulkAction: payload.action },
		})),
	);

	return NextResponse.json({ ok: true });
}
