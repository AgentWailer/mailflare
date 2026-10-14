import { getServerTranslator } from "@/lib/i18n/server";
import { SettingsSection, SettingsPageHeader } from "@/components/settings/settings-section";
import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { MfaSettings } from "@/components/settings/mfa-settings";

export default async function SettingsPage() {
	const t = await getServerTranslator();
	return <div className="space-y-3 py-4">
		<SettingsPageHeader title={t("settingsPage.security.title")} description={t("settingsPage.security.description")} />
		<SettingsSection id="password" title={t("settingsPage.security.changePassword")} description={t("settingsPage.security.changePasswordDescription")}>
			<ChangePasswordForm />
		</SettingsSection>
		<SettingsSection id="mfa" title={t("settingsPage.security.mfa")} description={t("settingsPage.security.mfaDescription")}>
			<MfaSettings />
		</SettingsSection>
	</div>;
}
