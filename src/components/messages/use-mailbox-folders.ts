"use client";

import { useEffect, useState } from "react";
import { getLabelPath } from "@/lib/folders/hierarchy";
import { AUTH_SESSION_CHANGED_EVENT, authFetch, getClientSessionToken } from "@/lib/auth/client";
import type { CustomFolder } from "@/components/dashboard-nav-types";

// Shared across toolbars so reopening a menu shows the folders immediately instead of popping in.
export const LABELS_CHANGED_EVENT = "mailflare:labels-changed";
let cacheGeneration = 0;
let cacheToken: string | null = null;
const cache = new Map<string, CustomFolder[]>();
const loadedAt = new Map<string, number>();
const requests = new Map<string, { generation: number; token: string | null; promise: Promise<CustomFolder[]> }>();

export function clearMailboxFoldersCache(): void {
	cacheGeneration += 1;
	cacheToken = getClientSessionToken();
	cache.clear();
	loadedAt.clear();
	requests.clear();
}

// Invalidate once per event, before any mounted menus schedule their refresh.
if (typeof window !== "undefined") {
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearMailboxFoldersCache);
	window.addEventListener(LABELS_CHANGED_EVENT, clearMailboxFoldersCache);
	window.addEventListener("mailflare:messages-changed", clearMailboxFoldersCache);
}

export function fetchMailboxFolders(mailboxId: string): Promise<CustomFolder[]> {
	const token = getClientSessionToken();
	if (cacheToken !== token) { clearMailboxFoldersCache(); cacheToken = token; }
	const pending = requests.get(mailboxId);
	if (pending?.generation === cacheGeneration && pending.token === token) return pending.promise;
	if (cache.has(mailboxId) && Date.now() - (loadedAt.get(mailboxId) ?? 0) < 30_000) return Promise.resolve(cache.get(mailboxId)!);
	const generation = cacheGeneration;
	const promise = authFetch(`/api/folders?${new URLSearchParams({ mailboxId })}`)
		.then(async response => { if (!response.ok) throw new Error("Unable to load labels"); return await response.json() as { folders?: CustomFolder[] }; })
		.then(data => {
			const labels = data.folders ?? [];
			const folders = labels.map(folder => ({ ...folder, path: getLabelPath(folder, labels) }));
			if (generation === cacheGeneration && token === getClientSessionToken()) { cache.set(mailboxId, folders); loadedAt.set(mailboxId, Date.now()); }
			return folders;
		}).finally(() => { if (requests.get(mailboxId)?.promise === promise) requests.delete(mailboxId); });
	requests.set(mailboxId, { generation, token, promise });
	return promise;
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
		const reload = () => {
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
		const loading = fetchMailboxFolders(mailboxId);
		const generation = cacheGeneration;
		loading
			.then((folders) => {
				if (cancelled || generation !== cacheGeneration) return;
				setFetched({ mailboxId, folders });
			})
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [mailboxId, revision]);

	if (!mailboxId) return [];
	return fetched?.mailboxId === mailboxId ? fetched.folders : cache.get(mailboxId) ?? [];
}
