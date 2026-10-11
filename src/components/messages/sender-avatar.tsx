"use client";

import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { getEmailAddress } from "@/lib/email/address";

const logos: Record<string, string> = {
	"linkedin.com": "linkedin",
	"google.com": "google",
	"microsoft.com": "microsoft",
};

export function SenderAvatar({ mailboxId, address, name, hasAvatar, managedAvatarUrl, className }: { mailboxId: string | null; address: string; name: string; hasAvatar?: boolean; managedAvatarUrl?: string; className?: string }) {
	const domain = getEmailAddress(address).toLowerCase().split("@").at(-1) ?? "";
	const logo = Object.entries(logos).find(([host]) => domain === host || domain.endsWith(`.${host}`))?.[1];
	return <ContactAvatar mailboxId={mailboxId} address={address} name={name} hasManagedAvatar={hasAvatar} managedAvatarUrl={managedAvatarUrl} fallbackAvatarUrl={logo ? `/sender-logos/${logo}.svg` : undefined} className={className} />;
}
