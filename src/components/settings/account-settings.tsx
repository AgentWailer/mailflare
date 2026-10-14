"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { LanguageSelector } from "@/components/language-selector";
import { Skeleton } from "@/components/ui/skeleton";
import { ForwardingEmailForm } from "./forwarding-email-form";
import { MailboxSignatureForm } from "./mailbox-signature-form";
import { ProfileForm } from "./profile-form";
import { TimeZoneForm } from "./time-zone-form";
import type { AccountSettingsResponse } from "./types";
import { loadAccountSettings } from "./utils";
import { SettingsSection, SettingsPageHeader } from "./settings-section";

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

	if (error) {
		return <p className="py-8 text-sm text-red-600">{error}</p>;
	}

	if (!user) {
		return (
			<div className="space-y-6 py-4">
				<Skeleton className="h-9 w-40" />
				{[0, 1, 2].map((key) => <Skeleton key={key} className="h-20 w-full rounded-2xl" />)}
			</div>
		);
	}

	return (
		<div className="space-y-3 py-4">
			<SettingsPageHeader title={t("settings.nav.account")} description={t("settings.account.detailsDescription")} />
			<SettingsSection id="profile" title={t("settings.account.detailsTitle")} description={t("settings.guide.profile")}>
				<ProfileForm initialName={user.name} initialResetEmail={user.resetEmail ?? ""} email={user.email} />
			</SettingsSection>
			{user.canForwardEmail && <SettingsSection id="forwarding" title={t("settings.account.forwardingTitle")} description={t("settings.account.forwardingDescription")}>
				<ForwardingEmailForm initialForwardingEmail={user.forwardingEmail ?? ""} />
			</SettingsSection>}
			<SettingsSection id="signature" title={t("settings.account.signatureTitle")} description={t("settings.account.signatureDescription")}>
				<MailboxSignatureForm />
			</SettingsSection>
			<SettingsSection id="language" title={t("language.label")} description={t("settings.guide.language")}>
				<div className="max-w-xs [&>div]:px-0 [&_label]:sr-only"><LanguageSelector /></div>
			</SettingsSection>
			<SettingsSection id="time-zone" title={t("settings.timeZone.title")} description={t("settings.guide.timeZone")}>
				<TimeZoneForm userId={user.id} initialTimeZone={user.timeZone} />
			</SettingsSection>
		</div>
	);
}
