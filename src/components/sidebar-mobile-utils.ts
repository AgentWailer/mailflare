"use client";

import { useSyncExternalStore } from "react";

const mobileQuery = "(max-width: 767px)";

// Environments without matchMedia (some test DOMs, embedded webviews) count as not mobile.
export function isMobileViewport(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia(mobileQuery).matches;
}

export function useIsMobile(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			if (typeof window.matchMedia !== "function") return () => {};
			const media = window.matchMedia(mobileQuery);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		isMobileViewport,
		() => false,
	);
}
