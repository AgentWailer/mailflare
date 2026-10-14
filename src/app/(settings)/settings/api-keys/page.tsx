import { getServerTranslator } from "@/lib/i18n/server";
import { SettingsSection, SettingsPageHeader } from "@/components/settings/settings-section";
import { ApiKeysSettings } from "@/components/settings/api-keys-settings";

export default async function SettingsPage() {
	const t = await getServerTranslator();
	return <div className="space-y-3 py-4">
		<SettingsPageHeader title={t("settings.nav.apiKeys")} description={t("settings.guide.api")} />
		<SettingsSection id="api-keys" title={t("apiKeys.title")} description={t("apiKeys.description")}>
			<ApiKeysSettings embedded />
		</SettingsSection>
	</div>;
}
