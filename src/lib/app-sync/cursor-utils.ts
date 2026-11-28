import type { AppSyncCursor } from "./sync-types";

export const SYNC_DEFAULT_DAYS = 30;
export const SYNC_MIN_DAYS = 7;
export const SYNC_MAX_DAYS = 90;
export const SYNC_DEFAULT_LIMIT = 100;
export const SYNC_MAX_LIMIT = 200;

function toBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
	return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function encodeCursor(cursor: AppSyncCursor): string {
	return toBase64Url(JSON.stringify(cursor));
}

/** Returns null for anything this server did not write, so the caller can ask for a fresh start. */
export function decodeCursor(value: string): AppSyncCursor | null {
	if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
	let data: unknown;
	try {
		data = JSON.parse(fromBase64Url(value));
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const cursor = data as Partial<AppSyncCursor>;
	if (cursor.v !== 1 || !Number.isSafeInteger(cursor.seq) || (cursor.seq as number) < 0) return null;
	if (!Number.isInteger(cursor.days) || (cursor.days as number) < SYNC_MIN_DAYS || (cursor.days as number) > SYNC_MAX_DAYS) return null;
	const backfill = cursor.backfill ?? null;
	if (backfill !== null) {
		if (typeof backfill !== "object" || !Number.isSafeInteger(backfill.createdAt) || typeof backfill.id !== "string" || !backfill.id || backfill.id.length > 200) return null;
	}
	return { v: 1, seq: cursor.seq as number, days: cursor.days as number, backfill: backfill ? { createdAt: backfill.createdAt, id: backfill.id } : null };
}

/** Bound a numeric query parameter; anything unreadable falls back to the default. */
export function clampSyncNumber(value: string | null, fallback: number, min: number, max: number): number {
	const parsed = value === null || value.trim() === "" ? NaN : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
