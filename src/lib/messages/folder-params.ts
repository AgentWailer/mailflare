import type { MessageFolder } from "@/hooks/types";

export function getMessageFolderParams(folder: MessageFolder, mailboxId?: string | null, folderId?: string | null): URLSearchParams {
	const params = new URLSearchParams();

	// All incoming mail, regardless of category, label, status or snooze state.
	if (folder === "all") params.set("direction", "inbound");

	if (folder === "inbox" || folder === "promotions" || folder === "social" || folder === "invoices" || folder === "orders") {
		params.set("direction", "inbound");
		params.set("status", "received");
		if(!folderId) params.set("category",folder === "inbox" ? "primary" : folder);
	}
	if (folder === "starred") params.set("starred", "true");
	if (folder === "snoozed") params.set("snoozed", "true");

	if (folder === "sent") {
		params.set("direction", "outbound");
		params.set("status", "sent");
	}

	if (folder === "scheduled") {
		params.set("direction", "outbound");
		params.set("scheduled", "true");
	}

	if (folder === "drafts") {
		params.set("direction", "outbound");
		params.set("status", "draft");
	}

	if (folder === "archived" || folder === "trash" || folder === "spam") {
		params.set("status", folder);
	}

	if (folderId) params.set("folderId", folderId);
	if (mailboxId) params.set("mailboxId", mailboxId);
	return params;
}
