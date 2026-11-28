"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLanguage } from "@/components/language-provider";
import { announceStatus, clearFailure, clearStatus, getFailure, getStatus, subscribeStatus } from "@/lib/status-announcer";

/**
 * Mounted once in the app providers. The polite live region stays in the DOM so screen readers hear each
 * confirmation; the visible pill fades after a few seconds. A new confirmation replaces the previous one.
 */
export function StatusToastHost() {
	const { t } = useLanguage();
	const status = useSyncExternalStore(subscribeStatus, getStatus, () => null);
	const failure = useSyncExternalStore(subscribeStatus, getFailure, () => null);
	// Hovering or focusing the confirmation pauses its dismissal, so an Undo being reached never vanishes.
	// Hover and focus are tracked separately and belong to one confirmation; a replacement starts fresh.
	const [interaction, setInteraction] = useState<{ id: number; hover: boolean; focus: boolean } | null>(null);
	const held = !!status && interaction?.id === status.id && (interaction.hover || interaction.focus);
	const hold = (part: "hover" | "focus", value: boolean) => { if (status) setInteraction(previous => ({ ...(previous?.id === status.id ? previous : { hover: false, focus: false }), id: status.id, [part]: value })); };
	useEffect(() => {
		if (!status || held) return;
		// An undo offer stays a little longer so it can be reached.
		const timer = setTimeout(() => clearStatus(status.id), status.undo ? 8000 : 5000);
		return () => clearTimeout(timer);
	}, [status, held]);
	// `data-compose-layer`: usable while a composer fills the screen (a refusal must be closable there).
	// Both sit above the "undo send" offers, which use the same corner (`--undo-stack-space`, globals.css).
	return (
		<div data-status-stack data-compose-layer className="status-stack pointer-events-none fixed inset-x-4 z-[120] flex flex-col items-center gap-2 md:inset-x-auto md:left-6 md:items-start">
			{/* A failure is not a confirmation: it interrupts, says what happened and stays until it is closed. */}
			<div role="alert">
				{failure && <div key={failure.id} data-status-failure className="status-toast-enter pointer-events-auto flex max-w-[min(32rem,calc(100vw-32px))] items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 shadow-lg">
					<p className="min-w-0 flex-1 break-words"><span className="block font-semibold">{t(failure.key)}</span>{failure.detail}</p>
					<button type="button" aria-label={t("notification.dismiss")} className="compose-toast-close -my-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded text-lg leading-none hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-red-700" onClick={() => {
						document.getElementById("main-content")?.focus({ preventScroll: true });
						clearFailure(failure.id);
					}}><span aria-hidden="true">×</span></button>
				</div>}
			</div>
			<div role="status" aria-live="polite">
				{status && <p key={status.id} data-status-toast onMouseEnter={() => hold("hover", true)} onMouseLeave={() => hold("hover", false)} onFocus={() => hold("focus", true)} onBlur={() => hold("focus", false)} className="status-toast-enter pointer-events-auto flex items-center gap-4 rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white shadow-lg">
					<span>{t(status.key)}</span>
					{status.undo && <button type="button" className="-my-1 rounded px-2 py-1 font-semibold text-blue-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-blue-300" onClick={() => {
						const undo = status.undo!;
						// The button is about to disappear: give focus a sensible home first.
						document.getElementById("main-content")?.focus({ preventScroll: true });
						clearStatus(status.id);
						// The inverse action announces its own result ("In den Posteingang verschoben").
						undo().catch(() => announceStatus("status.undoFailed"));
					}}>{t("status.undo")}</button>}
				</p>}
			</div>
		</div>
	);
}
