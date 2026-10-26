"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startMailboxPreload } from "./mailbox-preload";
import { preloadMessageReader } from "./reader-preload";

export function useMailboxPreload({ ready, mailboxId, href, grouped, search }: { ready: boolean; mailboxId?: string; href: string; grouped: boolean; search: string }) {
	const router = useRouter();
	useEffect(() => {
		if (!ready || !mailboxId || search.trim()) return;
		return startMailboxPreload({ mailboxId, href, grouped, preloadReader: preloadMessageReader, prefetchRoute: target => router.prefetch(target) });
	}, [ready, mailboxId, href, grouped, search, router]);
}
