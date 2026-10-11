"use client";

import { useLanguage } from "@/components/language-provider";
import type { Message } from "@/hooks/types";

/** Keep assigned labels visible even when the subject or preview is long. */
export function MessageLabelChips({ labels, compact = false }: { labels: Message["labels"]; compact?: boolean }) {
	const { t } = useLanguage();
	if (!labels?.length) return null;
	const names = labels.map(label => label.name).join(", ");
	const visible = compact ? 1 : 2;
	return (
		<span data-message-labels role="group" className={`inline-flex min-w-0 shrink-0 items-center gap-1 ${compact ? "max-w-[55%]" : "max-w-[70%]"}`} aria-label={`${t("smart.labels")}: ${names}`} title={names}>
			{labels.slice(0, visible).map(label => (
				<span key={label.id} title={label.name} className={`inline-flex min-w-0 items-center gap-1 rounded bg-neutral-100 font-normal leading-4 text-neutral-700 ${compact ? "max-w-32 px-1 text-[10px]" : "max-w-36 px-1.5 py-0.5 text-xs first:shrink-0"}`}>
					<span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
					<span className="truncate">{label.name}</span>
				</span>
			))}
			{labels.length > visible && <span className={`shrink-0 rounded bg-neutral-100 px-1 font-normal leading-4 text-neutral-700 ${compact ? "text-[10px]" : "py-0.5 text-xs"}`}>+{labels.length - visible}</span>}
		</span>
	);
}
