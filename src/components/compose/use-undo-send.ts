"use client";

import { useSyncExternalStore } from "react";

/** Seconds a sent message waits before delivery; 0 sends at once. */
export const UNDO_SEND_OPTIONS = [0, 5, 10, 20, 30] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_OPTIONS)[number];
const KEY = "mailflare-undo-send-seconds";
const EVENT = "mailflare:undo-send-changed";
let localPreference: UndoSendSeconds | null = null;

function isOption(value: number): value is UndoSendSeconds {
	return (UNDO_SEND_OPTIONS as readonly number[]).includes(value);
}

/** Off unless chosen: a held message reports delivery problems under Scheduled, not in the composer. */
export function readUndoSendSeconds(): UndoSendSeconds {
	if (localPreference !== null) return localPreference;
	try {
		const value = Number(localStorage.getItem(KEY));
		if (isOption(value)) return value;
	} catch { /* The in-memory preference also works without browser storage. */ }
	return 0;
}

function subscribe(notify: () => void) {
	const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) { localPreference = null; notify(); } };
	window.addEventListener(EVENT, notify);
	window.addEventListener("storage", storage);
	return () => { window.removeEventListener(EVENT, notify); window.removeEventListener("storage", storage); };
}

export function saveUndoSendSeconds(value: UndoSendSeconds) {
	localPreference = value;
	try { localStorage.setItem(KEY, String(value)); } catch { /* Optional persistence. */ }
	window.dispatchEvent(new Event(EVENT));
}

export function useUndoSendSeconds(): [UndoSendSeconds, (value: UndoSendSeconds) => void] {
	return [useSyncExternalStore(subscribe, readUndoSendSeconds, () => 0 as UndoSendSeconds), saveUndoSendSeconds];
}
