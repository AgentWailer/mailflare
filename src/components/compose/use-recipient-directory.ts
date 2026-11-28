"use client";

import { useEffect, useState } from "react";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import type { RecipientCandidate } from "@/lib/contacts/recipient-directory-types";

/** How long one loaded directory serves new composers before it is asked for again. */
const FRESH_MS = 5 * 60_000;
const EMPTY: RecipientCandidate[] = [];

/** A stalled request is given up, so what waits for the address book carries on without it. */
const REQUEST_TIMEOUT_MS = 8_000;
export type RecipientDirectoryAnswer = {
	/** The address book; after a failed read the last one that was read, or nobody. */
	directory: RecipientCandidate[];
	/** False when no address book is at hand: this read failed and there is no earlier one to go by. */
	ok: boolean;
};

/**
 * Somebody the owner wrote to or keeps as a contact. A message that was taken back, never left, or
 * still waits to go is no send: the address it was meant for stays a stranger, however it got into
 * the contacts.
 */
export function isKnownCorrespondent(candidate: RecipientCandidate): boolean {
	return (candidate.delivered ?? candidate.sends) > 0 || candidate.source === "manual";
}

let lastGood: { session: string | null; directory: RecipientCandidate[] } | null = null;

let cached: { session: string | null; at: number; promise: Promise<RecipientDirectoryAnswer> } | null = null;
/** Counts the reads: an answer that arrives after a later read began is older than that one's and is not kept. */
let reads = 0;

function isCandidate(value: unknown): value is RecipientCandidate {
	const item = value as RecipientCandidate;
	return !!item && typeof item.email === "string" && item.email.includes("@") && typeof item.sends === "number";
}

/** The ranked address book and whether it could be read, shared by every composer of this tab. */
export function loadRecipientDirectoryAnswer(force = false): Promise<RecipientDirectoryAnswer> {
	const session = getClientSessionToken();
	if (!force && cached && cached.session === session && Date.now() - cached.at < FRESH_MS) return cached.promise;
	const read = ++reads;
	const promise: Promise<RecipientDirectoryAnswer> = authFetch("/api/compose/recipients", { cache: "no-store", redirectOnUnauthorized: false, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
		.then(async (response) => {
			if (!response.ok) throw new Error("Recipient directory unavailable");
			const data = await response.json() as { recipients?: unknown };
			const directory = Array.isArray(data.recipients) ? data.recipients.filter(isCandidate) : EMPTY;
			// A slower, earlier read must not undo what a later one found: the later one answers for both.
			if (read !== reads && cached && cached.promise !== promise && cached.session === session) return cached.promise;
			// Read before the address book was known to be out of date, or for a reader who has left:
			// it answers its caller and is not kept.
			if (read === reads && session === getClientSessionToken()) lastGood = { session, directory };
			return { directory, ok: true };
		})
		.catch(() => {
			// Ask again next time instead of keeping the failure for five minutes.
			if (cached?.promise === promise) cached = null;
			// A somewhat older address book of the same reader still compares; none at all cannot.
			return lastGood?.session === session ? { directory: lastGood.directory, ok: true } : { directory: EMPTY, ok: false };
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
	reads += 1;
	// The last one read is kept for a caller that cannot wait: it counts only sends that went out,
	// so it cannot make a stranger known.
	for (const refresh of watchers) refresh();
}

/** Open readers and composers: they read the address book again when it is known to be out of date. */
const watchers = new Set<() => void>();

// A send that was taken back (`undo-send-toast.tsx`) says so with this event.
if (typeof window !== "undefined") window.addEventListener("mailflare:recipients-stale", invalidateRecipientDirectory);

/** The address book already read for this reader, if any, for a caller that cannot wait for a new read. */
export function knownRecipientDirectory(): RecipientCandidate[] | null {
	return lastGood?.session === getClientSessionToken() ? lastGood.directory : null;
}

/** The directory and whether the request for it has answered; an empty or failed answer is loaded too. */
export function useRecipientDirectoryState(enabled = true): { directory: RecipientCandidate[]; loaded: boolean } {
	const [state, setState] = useState<{ directory: RecipientCandidate[]; loaded: boolean }>({ directory: EMPTY, loaded: false });
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		const read = () => { void loadRecipientDirectory().then((directory) => { if (active) setState({ directory, loaded: true }); }); };
		read();
		watchers.add(read);
		return () => { active = false; watchers.delete(read); };
	}, [enabled]);
	return state;
}

export function useRecipientDirectory(enabled = true): RecipientCandidate[] {
	return useRecipientDirectoryState(enabled).directory;
}
