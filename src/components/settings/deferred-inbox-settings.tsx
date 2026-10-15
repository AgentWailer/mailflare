"use client";

import { lazy, Suspense } from "react";

const InboxThreadingSettings = lazy(() => import("./inbox-threading-settings").then(module => ({ default: module.InboxThreadingSettings })));
const LabelVisibilitySettings = lazy(() => import("./label-visibility-settings").then(module => ({ default: module.LabelVisibilitySettings })));
const PushNotificationSettings = lazy(() => import("./push-notification-settings").then(module => ({ default: module.PushNotificationSettings })));
const BrowserNotificationSettings = lazy(() => import("./browser-notification-settings").then(module => ({ default: module.BrowserNotificationSettings })));
const RecipientAddressSettings = lazy(() => import("./recipient-address-settings").then(module => ({ default: module.RecipientAddressSettings })));
const InboxShortcutsSettings = lazy(() => import("./inbox-shortcuts-settings").then(module => ({ default: module.InboxShortcutsSettings })));
const ExternalContentSettings = lazy(() => import("./external-content-settings").then(module => ({ default: module.ExternalContentSettings })));
const MailSortingSettings = lazy(() => import("./mail-sorting-settings").then(module => ({ default: module.MailSortingSettings })));
const SpamFilterSettings = lazy(() => import("./spam-filter-settings").then(module => ({ default: module.SpamFilterSettings })));
const PaperlessSettings = lazy(() => import("./paperless-settings").then(module => ({ default: module.PaperlessSettings })));
const TrashRetentionSettings = lazy(() => import("./trash-retention-settings").then(module => ({ default: module.TrashRetentionSettings })));
const MailboxAutoReplyForm = lazy(() => import("./mailbox-auto-reply-form").then(module => ({ default: module.MailboxAutoReplyForm })));

const sections = {
	threading: <InboxThreadingSettings />,
	labels: <LabelVisibilitySettings embedded />,
	notifications: <PushNotificationSettings />,
	browserNotifications: <BrowserNotificationSettings />,
	addresses: <RecipientAddressSettings />,
	shortcuts: <InboxShortcutsSettings />,
	external: <ExternalContentSettings />,
	sorting: <MailSortingSettings />,
	spam: <SpamFilterSettings />,
	paperless: <PaperlessSettings />,
	cleanup: <TrashRetentionSettings />,
	autoReply: <MailboxAutoReplyForm />,
};

/** Mounted by SettingsSection only on first expansion; visited forms stay mounted. */
export function DeferredInboxSettings({ section }: { section: keyof typeof sections }) {
	return <Suspense fallback={null}>{sections[section]}</Suspense>;
}
