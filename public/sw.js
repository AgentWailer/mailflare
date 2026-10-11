const DEFAULT_NOTIFICATION = {
	title: "New email",
	body: "You have a new message",
	icon: "/icon-192.png",
	badge: "/icon-96.png",
	url: "/inbox",
};

// No offline cache is maintained: updates can take control immediately.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	event.waitUntil(
		(async () => {
			let payload = DEFAULT_NOTIFICATION;
			try {
				payload = { ...DEFAULT_NOTIFICATION, ...(event.data?.json() ?? {}) };
			} catch {
				// Keep the generic notification if a provider delivers an empty or malformed payload.
			}
			// `badge` on showNotification is an image, not the Home Screen unread count.
			try {
				if (Number.isSafeInteger(payload.unreadCount) && payload.unreadCount >= 0) {
					if (payload.unreadCount > 0) await self.navigator.setAppBadge?.(payload.unreadCount);
					else await self.navigator.clearAppBadge?.();
				}
			} catch { /* Badge permission must not prevent the notification. */ }

			// Every Web Push must display a notification, including while the app is open.
			// Safari may revoke subscriptions that repeatedly deliver silent pushes.
			await self.registration.showNotification(payload.title, {
				body: payload.body,
				icon: payload.icon,
				badge: payload.badge,
				tag: payload.tag,
				data: { url: payload.url },
			});
		})(),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	let target = new URL("/inbox", self.location.origin);
	try {
		const requested = new URL(event.notification.data?.url || "/inbox", self.location.origin);
		if (requested.origin === self.location.origin) target = requested;
	} catch { /* Fall back to the inbox for malformed targets. */ }
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of windows) {
				if (new URL(client.url).origin === self.location.origin) {
					await client.focus();
					await client.navigate(target.href);
					return;
				}
			}
			await self.clients.openWindow(target.href);
		})(),
	);
});
