"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import type { PendingUndoSend } from "./compose-context";

/** How long the outcome of an undo stays on screen. */
const RESULT_MS = 4000;
/** The offer ends a little before delivery: an undo sent in the last instant would lose the race anyway. */
const SAFETY_MS = 700;

type Phase = "offer" | "working" | "restored" | "tooLate" | "failed";

/**
 * "Sending… Undo" after a message went out with an undo window. Undo cancels
 * the waiting delivery on the server, which returns the message to Drafts, and
 * reopens it in the composer. When delivery won the race, it says so.
 */
export function UndoSendToast({ pending, onDone, onRestored }: { pending: PendingUndoSend; onDone: () => void; onRestored: (draftId: string) => void }) {
	const { t } = useLanguage();
	const [phase, setPhase] = useState<Phase>("offer");
	const [duration] = useState(() => Math.max(0, pending.until - Date.now() - SAFETY_MS));

	useEffect(() => {
		if (phase === "working") return;
		const timer = setTimeout(onDone, phase === "offer" ? duration : RESULT_MS);
		return () => clearTimeout(timer);
	}, [duration, onDone, phase]);

	async function undo() {
		setPhase("working");
		try {
			const response = await authFetch(`/api/messages/${encodeURIComponent(pending.messageId)}/cancel-schedule`, { method: "POST", signal: AbortSignal.timeout(15000) });
			if (response.ok) {
				setPhase("restored");
				window.dispatchEvent(new Event("mailflare:messages-changed"));
				onRestored(pending.messageId);
				return;
			}
			// 409: delivery had already claimed the message.
			setPhase(response.status === 409 ? "tooLate" : "failed");
		} catch {
			setPhase("failed");
		}
	}

	const message = phase === "restored" ? t("compose.undo.restored")
		: phase === "tooLate" ? t("compose.undo.tooLate")
		: phase === "failed" ? t("compose.undo.failed")
		: t("compose.undo.pending");

	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			data-compose-layer
			data-undo-send
			role={phase === "tooLate" || phase === "failed" ? "alert" : "status"}
			// In the bottom left corner beside the desktop composer. Where the composer fills the screen
			// (phones, tablets), globals.css lifts it above the composer's send bar instead.
			className="fixed bottom-6 left-6 z-[180] flex w-max max-w-[calc(100vw-32px)] items-center gap-3 overflow-hidden rounded-xl bg-neutral-900 py-1 pl-4 pr-1 text-sm font-medium text-white shadow-xl"
		>
			<span className="min-w-0 py-2">{message}</span>
			{(phase === "offer" || phase === "working") ? (
				<button
					type="button"
					disabled={phase === "working"}
					onClick={() => void undo()}
					className="min-h-11 shrink-0 rounded-lg px-3 font-semibold text-blue-400 hover:bg-neutral-800 disabled:opacity-60"
				>
					{t("compose.undo.action")}
				</button>
			) : <span className="pr-3" />}
			{phase === "offer" && (
				<span aria-hidden="true" className="undo-send-progress absolute inset-x-0 bottom-0 h-1 origin-left bg-blue-400" style={{ animationDuration: `${duration}ms` }} />
			)}
		</div>,
		document.body,
	);
}
