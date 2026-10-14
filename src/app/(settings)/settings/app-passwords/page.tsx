import { getServerTranslator } from "@/lib/i18n/server";
import { SettingsSection, SettingsPageHeader } from "@/components/settings/settings-section";
import { EmailClientsSettings } from "@/components/settings/email-clients-settings";

export default async function SettingsPage() {
	const t = await getServerTranslator();
	return <div className="space-y-3 py-4">
		<SettingsPageHeader title={t("settingsPage.appPasswords.title")} description={t("settingsPage.appPasswords.description")} />
		<SettingsSection id="mail-apps" title={t("settings.nav.appPasswords")} description={t("settingsPage.appPasswords.description")}>
			<EmailClientsSettings />
		</SettingsSection>
	</div>;
}
