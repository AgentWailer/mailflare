"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { preloadMessageDetail } from "@/lib/messages/detail-cache";
import type { Message } from "@/hooks/types";
import type { MessageNavigationState } from "./message-navigation-types";
import { useMessageOpening } from "./message-opening";

export function useMessageNavigation(href: string, message: Message): MessageNavigationState {
	const pathname = usePathname();
	const router = useRouter();
	const opening = useMessageOpening();
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(hoverTimer.current), []);
	const [progress, setProgress] = useState<number | null>(null);

	useEffect(() => {
		if (progress === null) return;
		setProgress(100);
		const timer = window.setTimeout(() => setProgress(null), 220);
		return () => window.clearTimeout(timer);
	}, [pathname]);

	function onNavigate(event: MouseEvent<HTMLAnchorElement>, markRead = false) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		preloadMessageDetail({ ...message, read: markRead || message.read });
		if (href === pathname) {
			window.dispatchEvent(new CustomEvent("mailflare:message-retry", { detail: { messageId: message.id } }));
			return;
		}
		if (opening?.pendingMessageId === message.id) return;
		opening?.open(message, href);
		if (!opening) setProgress(12);
		try {
			router.push(href);
		} catch {
			opening?.cancel();
			setProgress(null);
			window.location.assign(href);
		}
	}

	return {
		progress: opening ? opening.pendingMessageId === message.id ? 12 : null : progress, onNavigate,
		onIntent: () => preloadMessageDetail(message),
		onHover: () => { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => preloadMessageDetail(message), 120); },
		onLeave: () => clearTimeout(hoverTimer.current),
	};
}

export function MessageNavigationProgress({ progress }: { progress: number | null }) {
	if (progress === null) return null;
	return (
		<div data-message-navigation-progress className="fixed inset-x-0 top-0 z-[120] h-1 bg-blue-100">
			<div className="h-full bg-blue-600 transition-[width] duration-100 ease-out" style={{ width: `${progress}%` }} />
		</div>
	);
}
