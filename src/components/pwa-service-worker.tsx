"use client";

import { useEffect } from "react";
import { getPushState, registerMailflareServiceWorker } from "@/lib/push/client";
import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";

export function PwaServiceWorker() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		void registerMailflareServiceWorker().catch((error) => {
			console.warn("Mailflare service worker registration failed", error);
		});
		function refreshSubscription() {
			// Rebind an existing subscription after login/session/account changes, without prompting.
			if (typeof Notification !== "undefined" && Notification.permission === "granted") void getPushState().catch(() => undefined);
		}
		refreshSubscription();
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refreshSubscription);
		window.addEventListener("focus", refreshSubscription);
		window.addEventListener("pageshow", refreshSubscription);
		return () => {
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refreshSubscription);
			window.removeEventListener("focus", refreshSubscription);
			window.removeEventListener("pageshow", refreshSubscription);
		};
	}, []);

	return null;
}
