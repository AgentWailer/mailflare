import type { ReorderableLayout } from "./reorderable-list-types";
const LAYOUT_CHANGED = "mailflare:nav-layout-changed";
const memoryLayouts = new Map<string, string>();

export function subscribeLayoutChanges(callback: () => void) {
	window.addEventListener(LAYOUT_CHANGED, callback); window.addEventListener("storage", callback);
	return () => { window.removeEventListener(LAYOUT_CHANGED, callback); window.removeEventListener("storage", callback); };
}
export function getLayoutSnapshot(key: string, fallbackKey?: string) {
	if (memoryLayouts.has(key)) return memoryLayouts.get(key)!;
	try { return localStorage.getItem(key) ?? (fallbackKey ? memoryLayouts.get(fallbackKey) ?? localStorage.getItem(fallbackKey) : null) ?? "{}"; }
	catch { return (fallbackKey ? memoryLayouts.get(fallbackKey) : null) ?? "{}"; }
}
export function parseLayoutSnapshot(raw: string): ReorderableLayout {
	try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/**
 * Saved placement first (dropping ids that no longer exist or repeat), then any item the
 * layout has never seen goes at the end of its default list.
 */
export function resolveLayout(defaults: ReorderableLayout, stored: ReorderableLayout, initialItemAfter?: Record<string, string>): ReorderableLayout {
	const known = new Set(Object.values(defaults).flat());
	const placed = new Set<string>();
	const layout: ReorderableLayout = {};
	for (const listId of Object.keys(defaults)) {
		layout[listId] = (Array.isArray(stored[listId]) ? stored[listId] : []).filter((id) => known.has(id) && !placed.has(id) && !!placed.add(id));
	}
	for (const [listId, ids] of Object.entries(defaults)) {
		for (const id of ids) {
			if (placed.has(id)) continue;
			const anchor = initialItemAfter?.[id];
			const index = anchor ? layout[listId].indexOf(anchor) : -1;
			if (index >= 0) layout[listId].splice(index + 1, 0, id);
			else layout[listId].push(id);
		}
	}
	return layout;
}

/** Take `id` out of whichever list holds it and insert it into `listId` before `beforeId` (end when null). */
export function moveItem(layout: ReorderableLayout, id: string, listId: string, beforeId: string | null): ReorderableLayout {
	if (beforeId === id) return layout;
	const next: ReorderableLayout = {};
	for (const [key, ids] of Object.entries(layout)) next[key] = ids.filter((item) => item !== id);
	const target = next[listId] ?? [];
	const index = beforeId === null ? -1 : target.indexOf(beforeId);
	if (index < 0) target.push(id);
	else target.splice(index, 0, id);
	next[listId] = target;
	return next;
}

export function readStorage<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

export function writeStorage(key: string, value: unknown) {
	const raw = JSON.stringify(value);
	try {
		localStorage.setItem(key, raw); memoryLayouts.delete(key);
	} catch {
		// Keep this session usable even when storage is unavailable or full.
		memoryLayouts.set(key, raw);
	}
	window.dispatchEvent(new Event(LAYOUT_CHANGED));
}
