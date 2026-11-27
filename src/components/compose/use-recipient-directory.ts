"use client";

import { useEffect, useState } from "react";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import type { RecipientCandidate } from "@/lib/contacts/recipient-directory-types";

/** How long one loaded directory serves new composers before it is asked for again. */
const FRESH_MS = 5 * 60_000;
const EMPTY: RecipientCandidate[] = [];

/** A stalled request is given up, so what waits for the address book carries on without it. */
const REQUEST_TIMEOUT_MS = 8_000;
export type RecipientDirectoryAnswer = { directory: RecipientCandidate[]; /** False when the address book could not be read. */ ok: boolean };

let cached: { session: string | null; at: number; promise: Promise<RecipientDirectoryAnswer> } | null = null;

function isCandidate(value: unknown): value is RecipientCandidate {
	const item = value as RecipientCandidate;
	return !!item && typeof item.email === "string" && item.email.includes("@") && typeof item.sends === "number";
}

/** The ranked address book and whether it could be read, shared by every composer of this tab. */
export function loadRecipientDirectoryAnswer(force = false): Promise<RecipientDirectoryAnswer> {
	const session = getClientSessionToken();
	if (!force && cached && cached.session === session && Date.now() - cached.at < FRESH_MS) return cached.promise;
	const promise = authFetch("/api/compose/recipients", { cache: "no-store", redirectOnUnauthorized: false, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
		.then(async (response) => {
			if (!response.ok) throw new Error("Recipient directory unavailable");
			const data = await response.json() as { recipients?: unknown };
			return { directory: Array.isArray(data.recipients) ? data.recipients.filter(isCandidate) : EMPTY, ok: true };
		})
		.catch(() => {
			// Ask again next time instead of keeping the failure for five minutes.
			if (cached?.promise === promise) cached = null;
			return { directory: EMPTY, ok: false };
		});
	cached = { session, at: Date.now(), promise };
	return promise;
}

/** The ranked address book. A failure yields no suggestions, never an error. */
export function loadRecipientDirectory(force = false): Promise<RecipientCandidate[]> {
	return loadRecipientDirectoryAnswer(force).then((answer) => answer.directory);
}

/** Forget the directory, e.g. after a send changed who is written to most. */
export function invalidateRecipientDirectory() {
	cached = null;
}

/** The directory and whether the request for it has answered; an empty or failed answer is loaded too. */
export function useRecipientDirectoryState(enabled = true): { directory: RecipientCandidate[]; loaded: boolean } {
	const [state, setState] = useState<{ directory: RecipientCandidate[]; loaded: boolean }>({ directory: EMPTY, loaded: false });
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		void loadRecipientDirectory().then((directory) => { if (active) setState({ directory, loaded: true }); });
		return () => { active = false; };
	}, [enabled]);
	return state;
}

export function useRecipientDirectory(enabled = true): RecipientCandidate[] {
	return useRecipientDirectoryState(enabled).directory;
}
