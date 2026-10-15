"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { inboxFolderConfig, invoicesFolderConfig, promotionsFolderConfig, socialFolderConfig, ordersFolderConfig } from "./message-folder-configs";
import { MessageSplitLayout } from "./message-split-layout";

const categories = [inboxFolderConfig, invoicesFolderConfig, promotionsFolderConfig, socialFolderConfig, ordersFolderConfig];

/** Keep the category list and reader above the route's loading boundary.
 * A cold destination changes the list's scope, never the mailbox shell.
 */
export function MessageCategoryLayout({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const config = categories.find(category => pathname === category.hrefPrefix || pathname.startsWith(`${category.hrefPrefix}/`));
	if (!config) return children;
	return <MessageSplitLayout config={config} renderOverview>{children}</MessageSplitLayout>;
}
