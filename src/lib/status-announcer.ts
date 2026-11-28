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
 * Something that went wrong where no window is left to say it (a send whose composer was closed).
 * Unlike a confirmation it stays until it is closed, and a later confirmation does not replace it.
 */
export type FailureAnnouncement = { id: number; key: TranslationKey; detail: string };

let failure: FailureAnnouncement | null = null;

export function announceFailure(key: TranslationKey, detail: string) {
	failure = { id: nextId++, key, detail };
	listeners.forEach((listener) => listener());
}

export function clearFailure(id: number) {
	if (failure?.id !== id) return;
	failure = null;
	listeners.forEach((listener) => listener());
}

export const getFailure = () => failure;

// A notice is about one reader's mail (a file name, a server's words): signing out or in as
// somebody else takes it away, as it takes the confirmation of the action before it.
if (typeof window !== "undefined") window.addEventListener("mailflare:auth-session-changed", () => {
	if (!failure && !current) return;
	failure = null;
	current = null;
	listeners.forEach((listener) => listener());
});

/**
 * Confirmation for actions that move mail out of the current view; read/unread stay silent.
 * `undo` (when the caller knows the inverse) adds a "Rückgängig" button to the confirmation.
 */
export function announceMessageAction(action: string, undo?: () => Promise<unknown>) {
	const key = ({ archive: "status.archived", trash: "status.trashed", spam: "status.spam", inbox: "status.inbox", folder: "status.moved", delete: "status.deleted", category: "status.moved" } as const)[action as "archive"];
	if (key) announceStatus(key, undo);
}
