"use client";

type BadgeNavigator = Navigator & {
	setAppBadge?: (count: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
};

export function supportsAppBadge(): boolean {
	return typeof navigator !== "undefined" && "setAppBadge" in navigator;
}

export async function updateAppBadge(count: number): Promise<void> {
	const badgeNavigator = navigator as BadgeNavigator;
	try {
		if (count > 0 && Number.isSafeInteger(count)) await badgeNavigator.setAppBadge?.(count);
		else await badgeNavigator.clearAppBadge?.();
	} catch {
		// Unsupported browsers or denied OS permissions must not interrupt the inbox.
	}
}
