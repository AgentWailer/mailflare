"use client";

import { useLanguage } from "@/components/language-provider";
import { useReadingLayout, type ReadingLayout } from "@/components/messages/use-reading-layout";
import { RoutingRuleSelect } from "./domain-routing/routing-rule-select";

export function InboxReadingLayoutSettings() {
	const { t } = useLanguage();
	const [layout, setLayout] = useReadingLayout();

	return (
		<label className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 sm:flex-row sm:items-start">
			<span className="flex-1">
				<span className="block text-sm font-medium text-neutral-900">{t("settings.reading.title")}</span>
				<span className="mt-1 block text-sm text-neutral-500">
					{t("settings.reading.description")}
				</span>
			</span>
			<RoutingRuleSelect className="min-h-11 text-base sm:w-auto" value={layout} onChange={event => setLayout(event.target.value as ReadingLayout)} aria-label={t("settings.reading.title")}>
				<option value="bottom">{t("settings.reading.bottom")}</option>
				<option value="right">{t("settings.reading.right")}</option>
				<option value="off">{t("settings.reading.off")}</option>
			</RoutingRuleSelect>
		</label>
	);
}
