import type { DraftPayload } from "@/app/api/drafts/types";
import { getClientSessionToken } from "@/lib/auth/client";
const PREFIX = "mailflare-compose-recovery:";
const SCOPE = "mailflare-recovery-scope";
export type DraftRecovery = { payload: DraftPayload; draftId: string | null; requestId: string; savedAt: number };
export function recoveryKey(mailboxId: string, draftId?: string | null): string | null {
	try {
		if (!getClientSessionToken()) return null;
		let scope = localStorage.getItem(SCOPE);
		if (!scope) { scope = crypto.randomUUID(); localStorage.setItem(SCOPE, scope); }
		return `${PREFIX}${scope}:${mailboxId}:${draftId ?? "new"}`;
	} catch { return null; }
}
export function readRecovery(key: string | null): DraftRecovery | null {
	try {
		if (!key) return null;
		const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as DraftRecovery | null;
		if (value?.payload && typeof value.requestId === "string" && Date.now() - value.savedAt < 86400000) return value;
		sessionStorage.removeItem(key);
	} catch { /* Storage can be disabled. */ }
	return null;
}
export function writeRecovery(key: string | null, value: DraftRecovery | null) {
	try {
		if (!key) return;
		if (!value) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, JSON.stringify(value));
	} catch { /* Navigation warning still protects unsaved work when storage is full. */ }
}
