import { getServerTranslator } from "@/lib/i18n/server";
import { SettingsSection, SettingsPageHeader } from "@/components/settings/settings-section";
import { InboxRules } from "@/components/settings/inbox-rules";
import { DomainRouting } from "@/components/settings/domain-routing/domain-routing";

export default async function SettingsPage() {
	const t = await getServerTranslator();
	return <div className="space-y-3 py-4">
		<SettingsPageHeader title={t("settings.nav.rules")} description={t("settings.guide.rules")} />
		<SettingsSection id="routing" title={t("routing.title")} description={t("routing.about")}>
			<DomainRouting />
		</SettingsSection>
		<SettingsSection id="filters" title={t("rules.mailboxTitle")} description={t("settings.guide.filters")}>
			<InboxRules />
		</SettingsSection>
	</div>;
}
