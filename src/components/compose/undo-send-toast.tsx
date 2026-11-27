"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import type { PendingUndoSend } from "./compose-context";

/** How long the outcome of an undo stays on screen. */
const RESULT_MS = 4000;
/** The offer ends a little before delivery: an undo sent in the last instant would lose the race anyway. */
export const UNDO_SAFETY_MS = 700;

type Phase = "offer" | "working" | "restored" | "inDrafts" | "tooLate" | "failed";

/** Typing fields keep Ctrl+Z for their own text. */
function isTyping(target: EventTarget | null): boolean {
	const element = target instanceof HTMLElement ? target : null;
	return !!element && (element.isContentEditable || element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT");
}

/**
 * "Sending… Undo" after a message went out with an undo window. Undo cancels
 * the waiting delivery on the server, which returns the message to Drafts, and
 * reopens it in the composer unless another message is being written there.
 * When delivery won the race, it says so. The offer lasts exactly as long as
 * the server holds the message, whatever else re-renders meanwhile.
 */
export function UndoSendToast({ pending, shortcut, onDone, onRestored }: {
	pending: PendingUndoSend;
	/** Ctrl+Z / ⌘Z takes this one back; with several waiting, the latest. */
	shortcut: boolean;
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
			const response = await authFetch(`/api/messages/${encodeURIComponent(pending.messageId)}/cancel-schedule`, { method: "POST", signal: AbortSignal.timeout(15000) });
			if (response.ok) {
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
	useEffect(() => {
		if (!shortcut || !offering) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "z" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
			event.preventDefault();
			void undoRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [offering, shortcut]);

	const message = phase === "restored" ? t("compose.undo.restored")
		: phase === "inDrafts" ? t("compose.undo.inDrafts")
		: phase === "tooLate" ? t("compose.undo.tooLate")
		: phase === "failed" ? t("compose.undo.failed")
		: t("compose.undo.pending");

	return (
		<div
			data-undo-send
			role={phase === "tooLate" || phase === "failed" ? "alert" : "status"}
			className="relative flex w-max max-w-full items-center gap-3 overflow-hidden rounded-xl bg-neutral-900 py-1 pl-4 pr-1 text-sm font-medium text-white shadow-xl"
		>
			<span className="min-w-0 py-2">{message}{offering && shortcut && <span className="sr-only"> {t("compose.undo.shortcut")}</span>}</span>
			{(phase === "offer" || phase === "working") ? (
				<button
					type="button"
					disabled={phase === "working"}
					onClick={() => void undo()}
					aria-keyshortcuts={shortcut ? "Control+Z Meta+Z" : undefined}
					title={shortcut ? t("compose.undo.shortcut") : undefined}
					className="min-h-11 shrink-0 rounded-lg px-3 font-semibold text-blue-400 hover:bg-neutral-800 disabled:opacity-60"
				>
					{t("compose.undo.action")}
				</button>
			) : <span className="pr-3" />}
			{phase === "offer" && (
				<span aria-hidden="true" className="undo-send-progress absolute inset-x-0 bottom-0 h-1 origin-left bg-blue-400" style={{ animationDuration: `${duration}ms` }} />
			)}
		</div>
	);
}
