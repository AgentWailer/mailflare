"use client";

import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { inboxFolderConfig, invoicesFolderConfig, promotionsFolderConfig, socialFolderConfig, ordersFolderConfig } from "./message-folder-configs";
import { MessageSplitLayout } from "./message-split-layout";
import { clearPendingMailNavigation, getPendingMailTraversal, recoverPendingMailTraversal } from "./pending-mail-navigation";

const categories = [inboxFolderConfig, invoicesFolderConfig, promotionsFolderConfig, socialFolderConfig, ordersFolderConfig];

/** Keep the category list and reader above the route's loading boundary.
 * A cold destination changes the list's scope, never the mailbox shell.
 */
export function MessageCategoryLayout({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	useLayoutEffect(() => { clearPendingMailNavigation(pathname); }, [pathname]);
	useEffect(() => {
		let active = true;
		function onTraversal() {
			const href = window.location.href;
			// Let the router finish its synchronous history bookkeeping first.
			queueMicrotask(() => {
				if (!active || window.location.href !== href) return;
				const token = getPendingMailTraversal();
				if (token === null) return;
				const target = new URL(href);
				if (!categories.some(category => category.hrefPrefix === target.pathname)) return;
				recoverPendingMailTraversal(token, () => router.replace(`${target.pathname}${target.search}${target.hash}`, { scroll: false }));
			});
		}
		window.addEventListener("popstate", onTraversal);
		return () => { active = false; window.removeEventListener("popstate", onTraversal); };
	}, [router]);
	const config = categories.find(category => pathname === category.hrefPrefix || pathname.startsWith(`${category.hrefPrefix}/`));
	if (!config) return children;
	return <MessageSplitLayout config={config} renderOverview>{children}</MessageSplitLayout>;
}
