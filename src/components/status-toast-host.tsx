"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useLanguage } from "@/components/language-provider";
import { clearStatus, getStatus, subscribeStatus } from "@/lib/status-announcer";

/**
 * Mounted once in the app providers. The polite live region stays in the DOM so screen readers hear each
 * confirmation; the visible pill fades after a few seconds. A new confirmation replaces the previous one.
 */
export function StatusToastHost() {
	const { t } = useLanguage();
	const status = useSyncExternalStore(subscribeStatus, getStatus, () => null);
	useEffect(() => {
		if (!status) return;
		const timer = setTimeout(() => clearStatus(status.id), 5000);
		return () => clearTimeout(timer);
	}, [status]);
	return (
		<div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-24 z-[120] flex justify-center md:inset-x-auto md:bottom-6 md:left-6 md:justify-start">
			{status && <p key={status.id} data-status-toast className="status-toast-enter rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white shadow-lg">{t(status.key)}</p>}
		</div>
	);
}
