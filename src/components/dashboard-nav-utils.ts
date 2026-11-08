import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MailCategory } from "@/lib/mail-sorting/categories";
import type { MessageCounts, MessageFolder } from "@/hooks/types";
import { authFetch } from "@/lib/auth/client";
import { announceMessageAction, announceStatus } from "@/lib/status-announcer";
import { invalidateMessageDetails } from "@/lib/messages/detail-cache";

export function getFolderNavCount(folder: MessageFolder, counts: MessageCounts["folders"]): number | undefined {
	return counts[folder].unread;
}

async function moveMessages(payload: { messageIds: string[]; action: BulkMessageAction; folderId?: string }) {
	const response = await authFetch("/api/messages/bulk", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) { announceStatus("status.moveFailed"); throw new Error("Unable to move messages"); }
	invalidateMessageDetails(payload.messageIds);
	announceMessageAction(payload.action);
	window.dispatchEvent(new Event("mailflare:messages-changed"));
}

export function moveMessagesToSystemFolder(messageIds: string[], action: "archive" | "spam" | "trash") {
	return moveMessages({ messageIds, action });
}

export function moveMessagesToCustomFolder(messageIds: string[], folderId: string) {
	return moveMessages({ messageIds, action: "folder", folderId });
}


export async function moveMessagesToCategory(messageIds: string[], category: MailCategory, mailboxId: string) {
 const response = await authFetch("/api/mail-organization", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mailboxId, messageIds, category, skipInbox: false }),
 });
 if (!response.ok) { announceStatus("status.moveFailed"); throw new Error("Unable to categorize messages"); }
 invalidateMessageDetails(messageIds);
 announceMessageAction("category");
 window.dispatchEvent(new Event("mailflare:messages-changed"));
}
