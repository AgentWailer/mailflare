"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { CustomFolder } from "@/components/dashboard-nav-types";

// Shared across toolbars so reopening a menu shows the folders immediately instead of popping in.
export const LABELS_CHANGED_EVENT = "mailflare:labels-changed";
let cacheGeneration = 0;
const cache = new Map<string, CustomFolder[]>();

export function clearMailboxFoldersCache(): void {
	cacheGeneration += 1;
	cache.clear();
}

export function notifyLabelsChanged(): void {
	clearMailboxFoldersCache();
	window.dispatchEvent(new Event(LABELS_CHANGED_EVENT));
	window.dispatchEvent(new Event("mailflare:messages-changed"));
}

export function useMailboxFolders(mailboxId: string | undefined): CustomFolder[] {
	const [revision, setRevision] = useState(0);
	const [fetched, setFetched] = useState<{ mailboxId: string; folders: CustomFolder[] } | null>(null);

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const reload = (event: Event) => {
			if (event.type === LABELS_CHANGED_EVENT) setFetched(null);
			clearTimeout(timer);
			timer = setTimeout(() => setRevision((value) => value + 1), 150);
		};
		window.addEventListener(LABELS_CHANGED_EVENT, reload);
		window.addEventListener("mailflare:messages-changed", reload);
		return () => {
			clearTimeout(timer);
			window.removeEventListener(LABELS_CHANGED_EVENT, reload);
			window.removeEventListener("mailflare:messages-changed", reload);
		};
	}, []);

	useEffect(() => {
		if (!mailboxId) return;
		let cancelled = false;
		const generation = cacheGeneration;
		authFetch(`/api/folders?${new URLSearchParams({ mailboxId }).toString()}`)
			.then((response) => response.json() as Promise<{ folders?: CustomFolder[] }>)
			.then((data) => {
				const folders = data.folders ?? [];
				if (cancelled || generation !== cacheGeneration) return;
				cache.set(mailboxId, folders);
				setFetched({ mailboxId, folders });
			})
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [mailboxId, revision]);

	if (!mailboxId) return [];
	return fetched?.mailboxId === mailboxId ? fetched.folders : cache.get(mailboxId) ?? [];
}
