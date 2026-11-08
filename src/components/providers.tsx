"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { clearMailboxClientState } from "@/components/mailbox-provider-utils";
import { BrandingProvider } from "@/components/branding-provider";
import { NewMessagePopup } from "@/components/new-message-popup";
import { ConfirmDialogHost } from "@/components/confirm-dialog";
import { StatusToastHost } from "@/components/status-toast-host";
import { PwaServiceWorker } from "@/components/pwa-service-worker";
import { AppBadgeSync } from "@/components/app-badge-sync";
import { ThemeSync } from "@/components/theme-sync";
import { useMessagePolling } from "@/hooks/use-message-polling";
import { clearMessageClientState } from "@/hooks/utils";
import { clearMessageDetailCache, MESSAGE_DETAILS_INVALIDATED_EVENT } from "@/lib/messages/detail-cache";
import { clearCurrentUserCache } from "@/hooks/use-current-user";
import { clearMailboxFoldersCache } from "@/components/messages/use-mailbox-folders";
import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";

export function Providers({ children }: { children: React.ReactNode }) {
	const realtime = useMessagePolling();
	const [sessionRevision, setSessionRevision] = useState(0);

	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchOnMount: false,
						refetchOnReconnect: false,
						refetchOnWindowFocus: false,
						staleTime: 60_000,
					},
				},
			}),
	);

	useEffect(() => {
		function resetUserScopedState() {
			client.clear();
			clearMailboxClientState();
			clearMessageClientState();
			clearMessageDetailCache();
			clearCurrentUserCache();
			clearMailboxFoldersCache();
			// Recreate account contexts, preferences and editors after replacing the session.
			setSessionRevision((revision) => revision + 1);
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
	}, [client]);

	// A moved message's reader labels are refetched next time it opens, instead of showing the old folder.
	useEffect(() => {
		const drop = (event: Event) => {
			const ids = new Set((event as CustomEvent<{ messageIds: string[] }>).detail?.messageIds ?? []);
			client.removeQueries({ queryKey: ["message-reader-labels"], predicate: (query) => ids.has(String(query.queryKey[2])) });
		};
		window.addEventListener(MESSAGE_DETAILS_INVALIDATED_EVENT, drop);
		return () => window.removeEventListener(MESSAGE_DETAILS_INVALIDATED_EVENT, drop);
	}, [client]);

	return (
		<QueryClientProvider client={client}>
			<BrandingProvider>
				<PwaServiceWorker />
				<ConfirmDialogHost />
				<StatusToastHost />
				<AppBadgeSync />
				<Fragment key={sessionRevision}>
					{children}
					<ThemeSync />
				</Fragment>
				{realtime.notification && (
					<NewMessagePopup
						notification={realtime.notification}
						onDismiss={realtime.dismissNotification}
					/>
				)}
			</BrandingProvider>
		</QueryClientProvider>
	);
}
