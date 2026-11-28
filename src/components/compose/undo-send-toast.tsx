"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import type { PendingUndoSend } from "./compose-context";

/** How long the outcome of an undo stays on screen. */
const RESULT_MS = 4000;
/** The offer ends a little before delivery: an undo sent in the last instant would lose the race anyway. */
export const UNDO_SAFETY_MS = 700;

type Phase = "offer" | "working" | "restored" | "inDrafts" | "tooLate" | "failed";

/** Typing fields keep Ctrl+Z for their own text; a checkbox or a button has none to undo. */
function isTyping(target: EventTarget | null): boolean {
	const element = target instanceof HTMLElement ? target : null;
	if (!element) return false;
	if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
	return element.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes((element as HTMLInputElement).type);
}

// The offers that can still be taken back, oldest first. Ctrl+Z / ⌘Z goes to the newest of them, so
// after one is taken back the shortcut serves the next instead of a toast that only shows a result.
const offers: { id: string; undo: () => void }[] = [];
function onShortcut(event: KeyboardEvent) {
	const newest = offers.at(-1);
	if (!newest || event.key.toLowerCase() !== "z" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
	event.preventDefault();
	newest.undo();
}
const watchers = new Set<() => void>();
function offerShortcut(id: string, undo: () => void): () => void {
	const entry = { id, undo };
	if (offers.length === 0) window.addEventListener("keydown", onShortcut);
	offers.push(entry);
	watchers.forEach((notify) => notify());
	return () => {
		const index = offers.indexOf(entry);
		if (index >= 0) offers.splice(index, 1);
		if (offers.length === 0) window.removeEventListener("keydown", onShortcut);
		watchers.forEach((notify) => notify());
	};
}
/** The message the shortcut would take back now: only its offer shows the key. */
function watchShortcut(notify: () => void): () => void {
	watchers.add(notify);
	return () => { watchers.delete(notify); };
}
const shortcutOwner = () => offers.at(-1)?.id ?? null;

/** ⌘Z on Apple keyboards, Ctrl+Z (as the interface language writes it) elsewhere. */
function isApple(): boolean {
	return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/**
 * "Sending… Undo" after a message went out with an undo window. Undo cancels
 * the waiting delivery on the server, which returns the message to Drafts, and
 * reopens it in the composer unless another message is being written there.
 * When delivery won the race, it says so. The offer lasts exactly as long as
 * the server holds the message, whatever else re-renders meanwhile.
 */
export function UndoSendToast({ pending, named, onDone, onRestored }: {
	pending: PendingUndoSend;
	/** Several messages wait: each offer says whom its message goes to. */
	named: boolean;
	onDone: (messageId: string) => void;
	/** Opens the restored message; false when it stays under Drafts instead. */
	onRestored: (draftId: string) => boolean;
}): ReactElement | null {
	const { t } = useLanguage();
	const [phase, setPhase] = useState<Phase>("offer");
	const [duration] = useState(() => Math.max(0, pending.until - Date.now() - UNDO_SAFETY_MS));
	const done = useRef(onDone);
	useEffect(() => { done.current = onDone; });

	useEffect(() => {
		if (phase === "working") return;
		// Measured against the deadline each time, so a re-render never grants the window again.
		const wait = phase === "offer" ? Math.max(0, pending.until - Date.now() - UNDO_SAFETY_MS) : RESULT_MS;
		const timer = setTimeout(() => done.current(pending.messageId), wait);
		return () => clearTimeout(timer);
	}, [pending.messageId, pending.until, phase]);

	async function undo() {
		setPhase("working");
		try {
			const response = await authFetch(`/api/messages/${encodeURIComponent(pending.messageId)}/cancel-schedule`, { method: "POST", redirectOnUnauthorized: false, signal: AbortSignal.timeout(15000) });
			if (response.ok) {
				// The address book read while this message waited counted it as written to. Said as an event:
				// importing the address book here would split it into a startup script of its own.
				window.dispatchEvent(new Event("mailflare:recipients-stale"));
				window.dispatchEvent(new Event("mailflare:messages-changed"));
				setPhase(onRestored(pending.messageId) ? "restored" : "inDrafts");
				return;
			}
			// 409: delivery had already claimed the message.
			setPhase(response.status === 409 ? "tooLate" : "failed");
		} catch {
			setPhase("failed");
		}
	}
	const undoRef = useRef(undo);
	useEffect(() => { undoRef.current = undo; });

	const offering = phase === "offer";
	useEffect(() => (offering ? offerShortcut(pending.messageId, () => void undoRef.current()) : undefined), [offering, pending.messageId]);
	const keys = t(isApple() ? "compose.undo.keysApple" : "compose.undo.keys");
	const hasShortcut = useSyncExternalStore(watchShortcut, shortcutOwner, () => null) === pending.messageId;

	const message = phase === "restored" ? t("compose.undo.restored")
		: phase === "inDrafts" ? t("compose.undo.inDrafts")
		: phase === "tooLate" ? t("compose.undo.tooLate")
		: phase === "failed" ? t("compose.undo.failed")
		: named && pending.recipient && pending.subject ? t("compose.undo.pendingAbout", { recipient: pending.recipient, subject: pending.subject.length > 40 ? `${pending.subject.slice(0, 39)}…` : pending.subject })
		: named && pending.recipient ? t("compose.undo.pendingTo", { recipient: pending.recipient })
		: t("compose.undo.pending");

	return (
		<div
			data-undo-send
			role={phase === "tooLate" || phase === "failed" ? "alert" : "status"}
			className="relative flex w-max max-w-full items-center gap-3 overflow-hidden rounded-xl bg-neutral-900 py-1 pl-4 pr-1 text-sm font-medium text-white shadow-xl"
		>
			<span className="min-w-0 py-2 [overflow-wrap:anywhere]">
				{message}
				{/* Read out with the offer: how long it lasts and the key that takes it back. */}
				{offering && <span className="sr-only"> {t(hasShortcut ? "compose.undo.hint" : "compose.undo.hintNoKeys", { seconds: Math.max(1, Math.round(duration / 1000)), keys })}</span>}
			</span>
			{(phase === "offer" || phase === "working") ? (
				<button
					type="button"
					disabled={phase === "working"}
					onClick={() => void undo()}
					aria-keyshortcuts={hasShortcut ? "Control+Z Meta+Z" : undefined}
					className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 font-semibold text-blue-400 hover:bg-neutral-800 disabled:opacity-60"
				>
					{t("compose.undo.action")}
					{/* The key is shown where there is a keyboard; a finger has the button. */}
					{hasShortcut && <kbd aria-hidden="true" data-undo-keys className="undo-send-keys rounded border border-neutral-600 px-1.5 py-0.5 font-sans text-xs font-medium text-neutral-300">{keys}</kbd>}
				</button>
			) : <span className="pr-3" />}
			{phase === "offer" && (
				<span aria-hidden="true" className="undo-send-progress absolute inset-x-0 bottom-0 h-1 origin-left bg-blue-400" style={{ animationDuration: `${duration}ms` }} />
			)}
		</div>
	);
}
