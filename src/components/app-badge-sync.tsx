"use client";

import { useEffect } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { supportsAppBadge, updateAppBadge } from "@/lib/push/app-badge";

export function AppBadgeSync() {
	useEffect(() => {
		if (!supportsAppBadge()) return;
		let generation = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: AbortController | undefined;
		async function refresh() {
			const current = ++generation;
			controller?.abort();
			controller = new AbortController();
			try {
				const response = await authFetch("/api/push/badge", { cache: "no-store", signal: controller.signal, redirectOnUnauthorized: false });
				if (current !== generation) return;
				if (response.status === 401) { await updateAppBadge(0); return; }
				if (!response.ok) return;
				const data = await response.json() as { unreadCount?: number };
				if (current === generation && typeof data.unreadCount === "number") await updateAppBadge(data.unreadCount);
			} catch { /* Keep the last known badge when the network is unavailable. */ }
		}
		function schedule() {
			// Invalidate immediately so a late response cannot overwrite a read/account change.
			generation++;
			controller?.abort();
			clearTimeout(timer);
			timer = setTimeout(() => { void refresh(); }, 150);
		}
		function onSessionChange() {
			void updateAppBadge(0);
			schedule();
		}
		function onVisible() { if (document.visibilityState === "visible") schedule(); }
		void refresh();
		const interval = setInterval(onVisible, 60_000);
		window.addEventListener("mailflare:messages-changed", schedule);
		window.addEventListener("mailflare:message-counts-changed", schedule);
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChange);
		window.addEventListener("storage", onSessionChange);
		window.addEventListener("focus", onVisible);
		window.addEventListener("pageshow", onVisible);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			generation++;
			controller?.abort();
			clearTimeout(timer);
			clearInterval(interval);
			window.removeEventListener("mailflare:messages-changed", schedule);
			window.removeEventListener("mailflare:message-counts-changed", schedule);
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChange);
			window.removeEventListener("storage", onSessionChange);
			window.removeEventListener("focus", onVisible);
			window.removeEventListener("pageshow", onVisible);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);
	return null;
}
