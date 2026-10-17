"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { DeferredProfileForm as ProfileForm, DeferredForwardingEmailForm as ForwardingEmailForm, DeferredMailboxSignatureForm as MailboxSignatureForm, DeferredTimeZoneForm as TimeZoneForm, DeferredWritingPreferencesSettings as WritingPreferencesSettings } from "./deferred-account-settings";
import { AppearanceSettings } from "./appearance-settings";
import { LanguageSelector } from "@/components/language-selector";
import { Skeleton } from "@/components/ui/skeleton";
import type { AccountSettingsResponse } from "./types";
import { loadAccountSettings } from "./utils";
import { SettingsSection, SettingsPageHeader, SettingsGroup } from "./settings-section";

export function AccountSettings() {
	const { t } = useLanguage();
	const [user, setUser] = useState<AccountSettingsResponse["user"]>();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		loadAccountSettings()
			.then((nextUser) => {
				if (!cancelled) setUser(nextUser);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : t("settings.account.loadFailed"));
			});

		return () => {
			cancelled = true;
		};
	}, [t]);

	return (
		<div className="space-y-3 py-4">
			<SettingsPageHeader title={t("settings.nav.account")} description={t("settings.account.detailsDescription")} />
			<SettingsGroup id="general" title={t("settings.account.generalTitle")}>
				<div className="grid gap-4 sm:grid-cols-2"><div id="language" className="[&>div]:px-0"><LanguageSelector /></div><AppearanceSettings compact /></div>
			</SettingsGroup>
			{error ? <p className="py-4 text-sm text-red-600">{error}</p> : !user ? <div className="space-y-3">{[0, 1, 2].map(key => <Skeleton key={key} className="h-20 w-full rounded-2xl" />)}</div> : <>
			<SettingsSection id="profile" title={t("settings.account.detailsTitle")} description={t("settings.guide.profile")}>
				<ProfileForm initialName={user.name} initialResetEmail={user.resetEmail ?? ""} email={user.email} />
			</SettingsSection>
			{user.canForwardEmail && <SettingsSection id="forwarding" title={t("settings.account.forwardingTitle")} description={t("settings.account.forwardingDescription")}>
				<ForwardingEmailForm initialForwardingEmail={user.forwardingEmail ?? ""} />
			</SettingsSection>}
			<SettingsSection id="signature" title={t("settings.account.signatureTitle")} description={t("settings.account.signatureDescription")}>
				<MailboxSignatureForm />
			</SettingsSection>
			<SettingsSection id="writing" title={t("writing.title")} description={t("writing.summary")}>
				<WritingPreferencesSettings />
			</SettingsSection>
			<SettingsSection id="time-zone" title={t("settings.timeZone.title")} description={t("settings.guide.timeZone")}>
				<TimeZoneForm userId={user.id} initialTimeZone={user.timeZone} />
			</SettingsSection>
			</>}
		</div>
	);
}
