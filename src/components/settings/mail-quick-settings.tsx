"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AppearanceSettings } from "./appearance-settings";
import { InboxReadingLayoutSettings } from "./inbox-reading-layout-settings";
import { MessageDensitySettings } from "./message-density-settings";

const viewportQuery = "(min-width: 1024px)";
function subscribeViewport(notify: () => void) {
	const media = window.matchMedia(viewportQuery);
	media.addEventListener("change", notify);
	return () => media.removeEventListener("change", notify);
}

export default function MailQuickSettings({ onClose }: { onClose: () => void }) {
	const { t } = useLanguage();
	const desktop = useSyncExternalStore(subscribeViewport, () => window.matchMedia(viewportQuery).matches, () => true);
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (!desktop) return;
		heading.current?.focus();
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, [desktop, onClose]);
	const closeButton = <button type="button" onClick={desktop ? onClose : undefined} aria-label={t("navigation.close")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><X aria-hidden="true" className="h-5 w-5" /></button>;
	const body = <>
		<div data-mail-quick-settings-header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-neutral-200 px-4 py-2">
			{desktop ? <h2 ref={heading} tabIndex={-1} className="min-w-0 flex-1 text-base leading-6 font-medium text-neutral-900 outline-none">{t("settings.quick.title")}</h2> : <DialogTitle className="min-w-0 flex-1 text-base leading-6 font-medium">{t("settings.quick.title")}</DialogTitle>}
			{desktop ? closeButton : <DialogClose asChild>{closeButton}</DialogClose>}
		</div>
		<div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
			<MessageDensitySettings />
			<div className="border-t border-neutral-200 pt-4"><InboxReadingLayoutSettings compact /></div>
			<div className="border-t border-neutral-200 pt-4"><AppearanceSettings compact /></div>
		</div>
		<div className="shrink-0 border-t border-neutral-200 p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
			<Link href="/settings/inbox" prefetch={false} onClick={onClose} className="flex min-h-11 items-center justify-center rounded-full border border-neutral-300 px-4 text-sm font-medium text-blue-700 hover:bg-blue-50">{t("settings.quick.allSettings")}</Link>
		</div>
	</>;
	if (desktop) return <aside id="mail-quick-settings" data-mail-quick-settings aria-label={t("settings.quick.title")} className="ml-3 mr-2 mb-2 flex min-h-0 w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl bg-white shadow-sm">{body}</aside>;
	return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
		<DialogContent id="mail-quick-settings" data-mail-quick-settings className="inset-x-0 bottom-0 top-auto flex max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-b-none rounded-t-3xl p-0 md:p-0" showCloseButton={false}>
			<DialogDescription className="sr-only">{t("settings.quick.description")}</DialogDescription>
			{body}
		</DialogContent>
	</Dialog>;
}
