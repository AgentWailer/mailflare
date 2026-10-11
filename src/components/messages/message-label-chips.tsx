"use client";

import { useLanguage } from "@/components/language-provider";
import type { Message } from "@/hooks/types";

/** Keep assigned labels visible even when the subject or preview is long. */
export function MessageLabelChips({ labels }: { labels: Message["labels"] }) {
	const { t } = useLanguage();
	if (!labels?.length) return null;
	const names = labels.map(label => label.name).join(", ");
	return (
		<span data-message-labels role="group" className="inline-flex min-w-0 max-w-[60%] shrink-0 items-center gap-1" aria-label={`${t("smart.labels")}: ${names}`} title={names}>
			{labels.slice(0, 2).map(label => (
				<span key={label.id} title={label.name} className="inline-flex min-w-0 max-w-28 items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-normal leading-4 text-neutral-700 first:max-w-[55%] first:shrink-0">
					<span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
					<span className="truncate">{label.name}</span>
				</span>
			))}
			{labels.length > 2 && <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-normal leading-4 text-neutral-700">+{labels.length - 2}</span>}
		</span>
	);
}
