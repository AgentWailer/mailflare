import type { TranslationKey } from "@/lib/i18n/types";

/** A short confirmation such as "Archived", shown and announced by the StatusToastHost. */
export type StatusAnnouncement = { id: number; key: TranslationKey };

let current: StatusAnnouncement | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

export function announceStatus(key: TranslationKey) {
	current = { id: nextId++, key };
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

/** Confirmation for actions that move mail out of the current view; read/unread stay silent. */
export function announceMessageAction(action: string) {
	const key = ({ archive: "status.archived", trash: "status.trashed", spam: "status.spam", inbox: "status.inbox", folder: "status.moved", delete: "status.deleted" } as const)[action as "archive"];
	if (key) announceStatus(key);
}
