import { getMessageQueryParams, fetchMessageList } from "@/hooks/utils";
import type { MessageFolder } from "@/hooks/types";

export async function preloadMailboxPage(href: string, mailboxId?: string) {
	const customFolderMatch = href.match(/^\/folders\/([^/]+)$/);
	const folder = (customFolderMatch ? "inbox" : href.slice(1)) as MessageFolder;
	const supportedFolders: MessageFolder[] = ["inbox", "promotions", "social", "invoices", "orders", "starred", "all", "snoozed", "sent", "scheduled", "drafts", "archived", "spam", "trash"];
	if (!supportedFolders.includes(folder)) return;

	let grouped = true;
	try { grouped = localStorage.getItem("mailflare-conversation-view") !== "off"; } catch { /* Default is conversation view. */ }
	const params = getMessageQueryParams(
		folder,
		mailboxId,
		{ limit: 25, offset: 0, group: grouped && folder !== "drafts" ? "thread" : undefined },
		customFolderMatch?.[1],
	);
	await fetchMessageList(params);
}
