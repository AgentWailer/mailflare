"use client";

import { lazy, Suspense, useState } from "react";
import { useLanguage } from "@/components/language-provider";

const MailQuickSettings = lazy(() => import("./mail-quick-settings"));

/** Keep the animation shell mounted, and load the controls only on first use. */
export function DeferredMailQuickSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
	const { t } = useLanguage();
	const [visited, setVisited] = useState(open);
	if (open && !visited) setVisited(true);
	return <div data-mail-quick-settings-slot data-open={open} aria-hidden={!open} inert={!open} className="contents min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none lg:flex" style={{ width: open ? 360 : 0 }}>
		{visited && <Suspense fallback={<div role="status" aria-label={t("settings.quick.title")} className="ml-3 mr-2 mb-2 hidden w-[340px] shrink-0 animate-pulse rounded-2xl bg-white lg:block" />}><MailQuickSettings open={open} onClose={onClose} /></Suspense>}
	</div>;
}
