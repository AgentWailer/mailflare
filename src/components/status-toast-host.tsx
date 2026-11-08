"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useLanguage } from "@/components/language-provider";
import { announceStatus, clearStatus, getStatus, subscribeStatus } from "@/lib/status-announcer";

/**
 * Mounted once in the app providers. The polite live region stays in the DOM so screen readers hear each
 * confirmation; the visible pill fades after a few seconds. A new confirmation replaces the previous one.
 */
export function StatusToastHost() {
	const { t } = useLanguage();
	const status = useSyncExternalStore(subscribeStatus, getStatus, () => null);
	useEffect(() => {
		if (!status) return;
		// An undo offer stays a little longer so it can be reached.
		const timer = setTimeout(() => clearStatus(status.id), status.undo ? 8000 : 5000);
		return () => clearTimeout(timer);
	}, [status]);
	return (
		<div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-24 z-[120] flex justify-center md:inset-x-auto md:bottom-6 md:left-6 md:justify-start">
			{status && <p key={status.id} data-status-toast className="status-toast-enter pointer-events-auto flex items-center gap-4 rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white shadow-lg">
				<span>{t(status.key)}</span>
				{status.undo && <button type="button" className="-my-1 rounded px-2 py-1 font-semibold text-blue-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-blue-300" onClick={() => {
					const undo = status.undo!;
					clearStatus(status.id);
					// The inverse action announces its own result ("In den Posteingang verschoben").
					undo().catch(() => announceStatus("status.undoFailed"));
				}}>{t("status.undo")}</button>}
			</p>}
		</div>
	);
}
