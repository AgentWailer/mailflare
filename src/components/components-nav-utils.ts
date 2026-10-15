import { getMessageQueryParams, fetchMessageList } from "@/hooks/utils";
import type { MessageFolder } from "@/hooks/types";

export function getMailboxPageParams(href: string, mailboxId?: string, conversationView?: boolean) {
	const customFolderMatch = href.match(/^\/folders\/([^/]+)$/);
	let customFolderId: string | undefined;
	try { customFolderId = customFolderMatch ? decodeURIComponent(customFolderMatch[1]) : undefined; } catch { return; }
	const folder = (customFolderMatch ? "inbox" : href.slice(1)) as MessageFolder;
	const supportedFolders: MessageFolder[] = ["inbox", "promotions", "social", "invoices", "orders", "starred", "all", "snoozed", "sent", "scheduled", "drafts", "archived", "spam", "trash"];
	if (!supportedFolders.includes(folder)) return;

	let grouped = conversationView ?? true;
	if (conversationView === undefined) try { grouped = localStorage.getItem("mailflare-conversation-view") !== "off"; } catch { /* Default is conversation view. */ }
	const params = getMessageQueryParams(
		folder,
		mailboxId,
		{ limit: 25, offset: 0, group: grouped && folder !== "drafts" ? "thread" : undefined },
		customFolderId,
	);
	return params;
}

export async function preloadMailboxPage(href: string, mailboxId?: string) {
	const params = getMailboxPageParams(href, mailboxId);
	if (params) await fetchMessageList(params);
}
