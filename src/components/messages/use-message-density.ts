"use client";

import { useSyncExternalStore } from "react";

export type MessageDensity = "comfortable" | "compact";
const KEY = "mailflare-message-density";
const EVENT = "mailflare:message-density-changed";
let localPreference: MessageDensity | null = null;

export function readMessageDensity(): MessageDensity {
	if (localPreference) return localPreference;
	try {
		const value = localStorage.getItem(KEY);
		if (value === "compact" || value === "comfortable") return value;
	} catch { /* The in-memory preference also works without browser storage. */ }
	return "comfortable";
}

function subscribe(notify: () => void) {
	const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) { localPreference = null; notify(); } };
	window.addEventListener(EVENT, notify);
	window.addEventListener("storage", storage);
	return () => { window.removeEventListener(EVENT, notify); window.removeEventListener("storage", storage); };
}

export function saveMessageDensity(value: MessageDensity) {
	localPreference = value;
	try { localStorage.setItem(KEY, value); } catch { /* Optional persistence. */ }
	window.dispatchEvent(new Event(EVENT));
}

export function useMessageDensity(): [MessageDensity, (value: MessageDensity) => void] {
	return [useSyncExternalStore(subscribe, readMessageDensity, () => "comfortable"), saveMessageDensity];
}
