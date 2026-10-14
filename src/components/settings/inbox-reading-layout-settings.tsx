"use client";

import { useLanguage } from "@/components/language-provider";
import { useReadingLayout, type ReadingLayout } from "@/components/messages/use-reading-layout";
import { RoutingRuleSelect } from "./domain-routing/routing-rule-select";

export function InboxReadingLayoutSettings({ compact = false }: { compact?: boolean } = {}) {
	const { t } = useLanguage();
	const [layout, setLayout] = useReadingLayout();

	return (
		<label className={compact ? "flex min-w-0 flex-col gap-1" : "flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 sm:flex-row sm:items-start"}>
			<span className="flex-1">
				<span className={compact ? "block text-xs text-neutral-600" : "block text-sm font-medium text-neutral-900"}>{t("settings.reading.title")}</span>
				{!compact && <span className="mt-1 block text-sm text-neutral-500">
					{t("settings.reading.description")}
				</span>}
			</span>
			<RoutingRuleSelect className={compact ? "min-h-11 w-full text-sm" : "min-h-11 text-base sm:w-auto"} value={layout} onChange={event => setLayout(event.target.value as ReadingLayout)} aria-label={t("settings.reading.title")}>
				<option value="bottom">{t("settings.reading.bottom")}</option>
				<option value="right">{t("settings.reading.right")}</option>
				<option value="off">{t("settings.reading.off")}</option>
			</RoutingRuleSelect>
		</label>
	);
}
