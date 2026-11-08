import type { TranslationKey } from "@/lib/i18n/types";

/** A short confirmation such as "Archived", shown and announced by the StatusToastHost. */
export type StatusAnnouncement = { id: number; key: TranslationKey; undo?: () => Promise<unknown> };

let current: StatusAnnouncement | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

export function announceStatus(key: TranslationKey, undo?: () => Promise<unknown>) {
	current = { id: nextId++, key, undo };
	listeners.forEach((listener) => listener());
}

export function clearStatus(id: number) {
	if (current?.id !== id) return;
	current = null;
	listeners.forEach((listener) => listener());
}

export function subscribeStatus(listener: () => void) {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export const getStatus = () => current;

/**
 * Confirmation for actions that move mail out of the current view; read/unread stay silent.
 * `undo` (when the caller knows the inverse) adds a "Rückgängig" button to the confirmation.
 */
export function announceMessageAction(action: string, undo?: () => Promise<unknown>) {
	const key = ({ archive: "status.archived", trash: "status.trashed", spam: "status.spam", inbox: "status.inbox", folder: "status.moved", delete: "status.deleted", category: "status.moved" } as const)[action as "archive"];
	if (key) announceStatus(key, undo);
}
