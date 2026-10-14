"use client";

import { useLanguage } from "@/components/language-provider";
import { useExternalContent } from "@/components/messages/use-external-content";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export function ExternalContentSettings() {
	const { t } = useLanguage();
	const { enabled, isLoading, saving, failed, setEnabled, retry } = useExternalContent();
	return <section  className="space-y-3">
		<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium text-neutral-900">{t("settings.externalContent.title")}</span>
				<span className="mt-1 block text-sm text-neutral-500">{t("settings.externalContent.description")}</span>
			</span>
			<Switch checked={isLoading ? true : enabled} disabled={isLoading || saving || failed} onCheckedChange={next => { void setEnabled(next).catch(() => {}); }} aria-label={t("settings.externalContent.title")} />
		</label>
		<p className="px-4 text-sm text-neutral-500">{t("settings.externalContent.privacy")}</p>
		{failed && <div role="alert" className="px-4 text-sm text-red-600"><p>{t("settings.externalContent.failed")}</p><Button variant="outline" className="mt-2" onClick={() => void retry()}>{t("labels.visibility.retry")}</Button></div>}
	</section>;
}
