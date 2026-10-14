import { getServerTranslator } from "@/lib/i18n/server";
import { SettingsSection, SettingsPageHeader } from "@/components/settings/settings-section";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { InboxReadingLayoutSettings } from "@/components/settings/inbox-reading-layout-settings";
import { InboxThreadingSettings } from "@/components/settings/inbox-threading-settings";
import { RecipientAddressSettings } from "@/components/settings/recipient-address-settings";
import { ExternalContentSettings } from "@/components/settings/external-content-settings";
import { LabelVisibilitySettings } from "@/components/settings/label-visibility-settings";
import { InboxShortcutsSettings } from "@/components/settings/inbox-shortcuts-settings";
import { PushNotificationSettings } from "@/components/settings/push-notification-settings";
import { BrowserNotificationSettings } from "@/components/settings/browser-notification-settings";
import { MailSortingSettings } from "@/components/settings/mail-sorting-settings";
import { PaperlessSettings } from "@/components/settings/paperless-settings";
import { SpamFilterSettings } from "@/components/settings/spam-filter-settings";
import { TrashRetentionSettings } from "@/components/settings/trash-retention-settings";
import { MailboxAutoReplyForm } from "@/components/settings/mailbox-auto-reply-form";
export default async function SettingsInboxPage() {
	const t = await getServerTranslator();
	return <div className="space-y-6 py-4">
		<SettingsPageHeader title={t("settings.nav.inbox")} description={t("settings.guide.inbox")} />
		<section className="space-y-3" aria-label={t("settingsPage.inbox.experience")}>
			<h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t("settingsPage.inbox.experience")}</h2>
			<SettingsSection id="appearance" title={t("settingsPage.inbox.appearance")} description={t("settings.guide.appearance")}>
				<div className="space-y-5">
					<AppearanceSettings />
					<div><h4 className="mb-2 text-sm font-medium">{t("settingsPage.inbox.readingLayout")}</h4><InboxReadingLayoutSettings /></div>
					<div><h4 className="mb-2 text-sm font-medium">{t("settingsPage.inbox.threading")}</h4><InboxThreadingSettings /></div>
				</div>
			</SettingsSection>
			<SettingsSection id="labels" title={t("labels.visibility.title")} description={t("settings.guide.labels")}>
				<LabelVisibilitySettings embedded />
			</SettingsSection>
			<SettingsSection id="notifications" title={t("settingsPage.inbox.notifications")} description={t("settingsPage.inbox.notificationsDescription")}>
				<div className="space-y-4"><PushNotificationSettings /><BrowserNotificationSettings /></div>
			</SettingsSection>
			<SettingsSection id="addresses" title={t("settingsPage.inbox.addresses")} description={t("settingsPage.inbox.addressesDescription")}>
				<RecipientAddressSettings />
			</SettingsSection>
			<SettingsSection id="shortcuts" title={t("settingsPage.inbox.shortcuts")} description={t("settingsPage.inbox.shortcutsDescription")}>
				<InboxShortcutsSettings />
			</SettingsSection>
			<SettingsSection id="external-content" title={t("settings.externalContent.title")} description={t("settings.guide.external")}>
				<ExternalContentSettings />
			</SettingsSection>
		</section>
		<section className="space-y-3" aria-label={t("settingsPage.inbox.handling")}>
			<h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t("settingsPage.inbox.handling")}</h2>
			<SettingsSection id="sorting" title={t("smart.title")} description={t("settings.guide.sorting")}>
				<MailSortingSettings />
			</SettingsSection>
			<SettingsSection id="spam" title={t("settingsPage.inbox.spamProtection")} description={t("settingsPage.inbox.spamProtectionDescription")}>
				<SpamFilterSettings />
			</SettingsSection>
			<SettingsSection id="paperless" title={t("paperless.title")} description={t("settings.guide.paperless")}>
				<PaperlessSettings />
			</SettingsSection>
			<SettingsSection id="cleanup" title={t("settingsPage.inbox.cleanup")} description={t("settingsPage.inbox.cleanupDescription")}>
				<TrashRetentionSettings />
			</SettingsSection>
			<SettingsSection id="auto-reply" title={t("settingsPage.inbox.autoReply")} description={t("settingsPage.inbox.autoReplyDescription")}>
				<MailboxAutoReplyForm />
			</SettingsSection>
		</section>
	</div>;
}
