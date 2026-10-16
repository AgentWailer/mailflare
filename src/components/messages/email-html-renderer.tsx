"use client";

import { useLanguage } from "@/components/language-provider";
import { useEffect, useRef, useState } from "react";
import { prepareEmailHtml } from "@/lib/email/html";
import { collapseQuotedEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/quote-collapse-utils";
import { fitEmailToWidth } from "./fit-email-to-width";
import { createEmailTheme } from "./email-theme";
import { useExternalContent } from "./use-external-content";
import { preferNativeAmazonLinks } from "./native-app-links";

const BASE_STYLE = `
:host { display:block; min-width:0; isolation:isolate; contain:paint; }
.email-quote-toggle { margin-top:1.4em; }
.email-quote-toggle > summary { cursor:pointer; list-style:none; width:26px; border-radius:20px; background:#ececec; text-align:center; }
.email-quote-toggle > summary::-webkit-details-marker { display:none; }
.email-quote-toggle > summary::before { content:'•••'; }
.email-quote-content { display:flow-root; }
@media (max-width:1023px), (hover:none) and (pointer:coarse) { .email-quote-toggle > summary { width:44px; min-height:44px; display:flex; align-items:center; justify-content:center; } }
`;

export function EmailHtmlRenderer({ html, className, preserveLeadingQuote = false }: {
	html: string; className?: string; preserveLeadingQuote?: boolean;
}) {
	const { t } = useLanguage();
	const host = useRef<HTMLDivElement>(null);
	const preference = useExternalContent();
	const [remoteOverride, setRemoteOverride] = useState<{ html: string; settings: typeof preference.settings; enabled: boolean } | null>(null);
	const [hasRemote, setHasRemote] = useState(false);
	const [originalColorsSource, setOriginalColorsSource] = useState<string | null>(null);
	const allowRemote = !preference.isLoading && !preference.failed && (
		remoteOverride?.html === html && remoteOverride.settings === preference.settings
			? remoteOverride.enabled : preference.enabled
	);
	const originalColors = originalColorsSource === html;
	useEffect(() => {
		if (!host.current) return;
		host.current.dir = document.documentElement.dir || "ltr";
		const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" });
		const prepared = prepareEmailHtml(html, { reader: true, allowRemote });
		setHasRemote(prepared.hasRemote);
		const base = document.createElement("style");
		base.textContent = `${BASE_STYLE}\n${prepared.rootTag} { display:block; font:14px/1.5 Arial,sans-serif; color:#202124; background:#fff; color-scheme:light; overflow-wrap:anywhere; }\n${prepared.bodyTag} { display:block; }`;
		const content = document.createElement("template");
		content.innerHTML = collapseQuotedEmailHtml(prepared.html, preserveLeadingQuote) ?? "";
		const viewport = document.createElement(`${prepared.rootTag}-viewport`);
		const canvas = document.createElement(`${prepared.rootTag}-canvas`);
		canvas.appendChild(content.content);
		viewport.appendChild(canvas);
		root.replaceChildren(base, viewport);
		const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
		preferNativeAmazonLinks(root, ios && ((navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches));
		const mailBody = root.querySelector(prepared.bodyTag);
		// Preserve the message direction inside the fitted presentation surface.
		if (mailBody) host.current.dir = window.getComputedStyle(mailBody).direction;
		const stopFitting = fitEmailToWidth(host.current, viewport, canvas);
		// Document fragment navigation does not automatically find IDs inside a shadow tree.
		const navigate = (event: Event) => {
			const target = event.target as Element | null;
			const anchor = target?.closest("a[href]");
			const href = anchor?.getAttribute("href");
			if (!href?.startsWith("#")) return;
			event.preventDefault();
			try {
				const id = decodeURIComponent(href.slice(1));
				const destination = root.getElementById(id) ?? Array.from(root.querySelectorAll("a[name]")).find(node => node.getAttribute("name") === id);
				destination?.scrollIntoView({ block: "start" });
			} catch { /* Ignore malformed fragments. */ }
		};
		root.addEventListener("click", navigate);
		return () => { stopFitting(); root.removeEventListener("click", navigate); };
	}, [html, allowRemote, preserveLeadingQuote]);
	useEffect(() => {
		const root = host.current?.shadowRoot;
		if (!root) return;
		const theme = createEmailTheme(root);
		const synchronize = () => theme.setDark(!originalColors && document.documentElement.classList.contains("dark"));
		const observer = new MutationObserver(synchronize);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		synchronize();
		return () => { observer.disconnect(); theme.restore(); };
	}, [html, allowRemote, preserveLeadingQuote, originalColors]);
	return <div className={`min-w-0 max-w-full ${className ?? ""}`}>
		<div className="mb-2 flex flex-wrap justify-end gap-2">
			<button type="button" aria-pressed={originalColors} className="email-presentation-action hidden items-center rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:inline-flex" onClick={() => setOriginalColorsSource(originalColors ? null : html)}>{t(originalColors ? "message.adaptColors" : "message.originalColors")}</button>
			{hasRemote &&
			<button type="button" aria-pressed={allowRemote} disabled={preference.isLoading || preference.failed} className="email-presentation-action rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50"
				onClick={() => setRemoteOverride({ html, settings: preference.settings, enabled: !allowRemote })}>
				{allowRemote ? t("message.blockRemote") : t("message.allowRemote")}
			</button>
			}
		</div>
		<div data-email-reader className="w-full min-w-0 max-w-full overflow-hidden" ref={host} />
	</div>;
}
