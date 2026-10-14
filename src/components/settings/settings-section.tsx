"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useLanguage } from "@/components/language-provider";

type SettingsSectionProps = {
	id: string;
	title: string;
	description?: string;
	children: ReactNode;
};

/** Mount on first visit, then retain forms and in-flight actions when collapsed. */
export function SettingsSection({ id, title, description, children }: SettingsSectionProps) {
	const [open, setOpen] = useState(false);
	const [visited, setVisited] = useState(false);
	const section = useRef<HTMLElement>(null);

	useEffect(() => {
		function revealHash() {
			let hash = "";
			try { hash = decodeURIComponent(location.hash.slice(1)); } catch { return; }
			if (hash !== id) return;
			setVisited(true);
			setOpen(true);
			requestAnimationFrame(() => section.current?.scrollIntoView({ block: "start" }));
		}
		function revealLink(event: MouseEvent) {
			const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
			if (!anchor) return;
			const url = new URL(anchor.getAttribute("href")!, location.href);
			if (url.origin === location.origin && url.pathname === location.pathname && url.hash === `#${id}`) {
				setVisited(true);
				setOpen(true);
			}
		}
		revealHash();
		window.addEventListener("hashchange", revealHash);
		document.addEventListener("click", revealLink);
		return () => {
			window.removeEventListener("hashchange", revealHash);
			document.removeEventListener("click", revealLink);
		};
	}, [id]);

	return <section ref={section} id={id} data-settings-section className="scroll-mt-4 overflow-hidden rounded-2xl border border-neutral-200/80 bg-white">
		<h3>
			<button type="button" aria-expanded={open} aria-controls={`${id}-content`} onClick={() => { setVisited(true); setOpen(value => !value); }} className="flex min-h-16 w-full items-center gap-4 p-4 text-left transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 sm:px-5">
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-semibold text-neutral-900 sm:text-base">{title}</span>
					{description && <span className="mt-1 block text-sm font-normal leading-5 text-neutral-500">{description}</span>}
				</span>
				<ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
			</button>
		</h3>
		<div id={`${id}-content`} hidden={!open} className="border-t border-neutral-100 p-4 sm:p-5">{visited && children}</div>
	</section>;
}

export function SettingsPageHeader({ title, description }: { title: string; description?: string }) {
	const { t } = useLanguage();
	return <header className="mb-6 space-y-2">
		<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{title}</h1>
		{description && <p className="text-sm leading-6 text-neutral-600">{description}</p>}
		<p className="text-xs leading-5 text-neutral-500">{t("settings.guide.hint")}</p>
	</header>;
}
