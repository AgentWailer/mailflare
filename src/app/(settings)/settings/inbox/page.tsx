import { DeferredInboxSettings } from "@/components/settings/deferred-inbox-settings";
import { getServerTranslator } from "@/lib/i18n/server";
import { SettingsSection, SettingsPageHeader, SettingsGroup } from "@/components/settings/settings-section";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { InboxReadingLayoutSettings } from "@/components/settings/inbox-reading-layout-settings";
import { MessageDensitySettings } from "@/components/settings/message-density-settings";
export default async function SettingsInboxPage() {
	const t = await getServerTranslator();
	return <div className="space-y-6 py-4">
		<SettingsPageHeader title={t("settings.nav.inbox")} description={t("settings.guide.inbox")} />
		<section className="space-y-3" aria-label={t("settingsPage.inbox.experience")}>
			<h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t("settingsPage.inbox.experience")}</h2>
			<SettingsGroup id="appearance" title={t("settingsPage.inbox.appearance")}>
				<div className="grid gap-4 sm:grid-cols-2"><AppearanceSettings compact /><InboxReadingLayoutSettings compact /><MessageDensitySettings className="sm:col-span-2" /></div>
			</SettingsGroup>
			<SettingsSection id="conversations" title={t("settingsPage.inbox.threading")} description={t("settingsPage.inbox.threadingDescription")}><DeferredInboxSettings section="threading" /></SettingsSection>
			<SettingsSection id="labels" title={t("labels.visibility.title")} description={t("settings.guide.labels")}>
				<DeferredInboxSettings section="labels" />
			</SettingsSection>
			<SettingsSection id="notifications" title={t("settingsPage.inbox.notifications")} description={t("settingsPage.inbox.notificationsDescription")}>
				<div className="space-y-4"><DeferredInboxSettings section="notifications" /><DeferredInboxSettings section="browserNotifications" /></div>
			</SettingsSection>
			<SettingsSection id="addresses" title={t("settingsPage.inbox.addresses")} description={t("settingsPage.inbox.addressesDescription")}>
				<DeferredInboxSettings section="addresses" />
			</SettingsSection>
			<SettingsSection id="shortcuts" title={t("settingsPage.inbox.shortcuts")} description={t("settingsPage.inbox.shortcutsDescription")}>
				<DeferredInboxSettings section="shortcuts" />
			</SettingsSection>
			<SettingsSection id="external-content" title={t("settings.externalContent.title")} description={t("settings.guide.external")}>
				<DeferredInboxSettings section="external" />
			</SettingsSection>
		</section>
		<section className="space-y-3" aria-label={t("settingsPage.inbox.handling")}>
			<h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t("settingsPage.inbox.handling")}</h2>
			<SettingsSection id="sorting" title={t("smart.title")} description={t("settings.guide.sorting")}>
				<DeferredInboxSettings section="sorting" />
			</SettingsSection>
			<SettingsSection id="spam" title={t("settingsPage.inbox.spamProtection")} description={t("settingsPage.inbox.spamProtectionDescription")}>
				<DeferredInboxSettings section="spam" />
			</SettingsSection>
			<SettingsSection id="paperless" title={t("paperless.title")} description={t("settings.guide.paperless")}>
				<DeferredInboxSettings section="paperless" />
			</SettingsSection>
			<SettingsSection id="cleanup" title={t("settingsPage.inbox.cleanup")} description={t("settingsPage.inbox.cleanupDescription")}>
				<DeferredInboxSettings section="cleanup" />
			</SettingsSection>
			<SettingsSection id="auto-reply" title={t("settingsPage.inbox.autoReply")} description={t("settingsPage.inbox.autoReplyDescription")}>
				<DeferredInboxSettings section="autoReply" />
			</SettingsSection>
		</section>
	</div>;
}
