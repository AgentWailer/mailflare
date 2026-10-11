"use client";

import { authFetch } from "@/lib/auth/client";

type PushConfigResponse = {
	enabled: boolean;
	publicKey: string | null;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function decodeBase64Url(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function browserSupportsPush(): boolean {
	return (
		typeof window !== "undefined" &&
		window.isSecureContext &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	);
}

export function needsHomeScreenInstallation(): boolean {
	if (typeof window === "undefined") return false;
	const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
	return ios && !standalone;
}

export async function registerMailflareServiceWorker(): Promise<ServiceWorkerRegistration> {
	if (!("serviceWorker" in navigator)) throw new Error("Service workers are not supported by this browser");
	const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	// A first install can still be activating when subscribe() is called.
	return registration.active ? registration : navigator.serviceWorker.ready;
}

function matchesServerKey(subscription: PushSubscription, publicKey: string): boolean {
	const key = subscription.options?.applicationServerKey;
	if (!key) return false;
	const current = new Uint8Array(key);
	const expected = decodeBase64Url(publicKey);
	return current.length === expected.length && current.every((byte, index) => byte === expected[index]);
}

async function loadPushConfig(): Promise<PushConfigResponse> {
	const response = await authFetch("/api/push/config", { redirectOnUnauthorized: false });
	if (!response.ok) throw new Error("Failed to load push notification settings");
	return (await response.json()) as PushConfigResponse;
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
	const json = subscription.toJSON();
	if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
		throw new Error("Browser returned an incomplete push subscription");
	}
	const response = await authFetch("/api/push/subscriptions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			endpoint: json.endpoint,
			keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
		}),
		redirectOnUnauthorized: false,
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(data?.error || "Failed to save push subscription");
	}
}

export async function getPushState(): Promise<{
	supported: boolean;
	configured: boolean;
	permission: NotificationPermission | "unsupported";
	subscribed: boolean;
	syncFailed: boolean;
}> {
	if (!browserSupportsPush()) {
		return { supported: false, configured: false, permission: "unsupported", subscribed: false, syncFailed: false };
	}
	const [config, registration] = await Promise.all([
		loadPushConfig(),
		registerMailflareServiceWorker(),
	]);
	const subscription = await registration.pushManager.getSubscription();
	let subscribed = !!subscription && !!config.publicKey && matchesServerKey(subscription, config.publicKey) && Notification.permission === "granted";
	let syncFailed = false;
	if (subscription && subscribed && config.enabled) {
		try { await saveSubscription(subscription); }
		catch { subscribed = false; syncFailed = true; }
	}
	return {
		supported: true,
		configured: config.enabled && !!config.publicKey,
		permission: Notification.permission,
		subscribed,
		syncFailed,
	};
}

export async function enablePushNotifications(): Promise<void> {
	if (!browserSupportsPush()) throw new Error("Push notifications are not supported by this browser");
	const permission = await Notification.requestPermission();
	if (permission !== "granted") throw new Error("Notification permission was not granted");

	const config = await loadPushConfig();
	if (!config.enabled || !config.publicKey) throw new Error("Push notifications are not configured on this server");

	const registration = await registerMailflareServiceWorker();
	let subscription = await registration.pushManager.getSubscription();
	if (subscription && !matchesServerKey(subscription, config.publicKey)) {
		if (!(await subscription.unsubscribe())) throw new Error("Failed to replace the old push subscription");
		subscription = null;
	}
	if (!subscription) {
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: toArrayBuffer(decodeBase64Url(config.publicKey)),
		});
	}

	try {
		await saveSubscription(subscription);
		window.dispatchEvent(new Event("mailflare:messages-changed"));
	} catch (error) {
		await subscription.unsubscribe().catch(() => false);
		throw error;
	}
}

export async function disablePushNotifications(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const registration = await navigator.serviceWorker.getRegistration("/");
	const subscription = await registration?.pushManager.getSubscription();
	if (!subscription) return;

	const response = await authFetch("/api/push/subscriptions", {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ endpoint: subscription.endpoint }),
		redirectOnUnauthorized: false,
	});
	if (!response.ok) throw new Error("Failed to disable push notifications");
	if (!(await subscription.unsubscribe())) throw new Error("Failed to unsubscribe this device");
}

export async function hasActivePushSubscription(): Promise<boolean> {
	if (!browserSupportsPush() || Notification.permission !== "granted") return false;
	const [registration, config] = await Promise.all([
		navigator.serviceWorker.getRegistration("/"),
		loadPushConfig(),
	]);
	if (!config.enabled || !config.publicKey) return false;
	const subscription = await registration?.pushManager.getSubscription();
	return !!subscription && matchesServerKey(subscription, config.publicKey);
}

export async function sendTestPushNotification(): Promise<void> {
	const registration = await registerMailflareServiceWorker();
	const subscription = await registration.pushManager.getSubscription();
	if (!subscription) throw new Error("No push subscription for this device");
	const response = await authFetch("/api/push/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ endpoint: subscription.endpoint }),
		redirectOnUnauthorized: false,
	});
	if (!response.ok) throw new Error("Push test could not be delivered");
}
