"use client";

import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { knownSenderLogo, senderLogoDomain } from "@/lib/contacts/sender-logos";

export function SenderAvatar({ mailboxId, address, name, hasAvatar, managedAvatarUrl, className }: { mailboxId: string | null; address: string; name: string; hasAvatar?: boolean; managedAvatarUrl?: string; className?: string }) {
	const logo = knownSenderLogo(address);
	const fallback = logo ? `/sender-logos/${logo}.svg` : mailboxId && senderLogoDomain(address) ? `/api/contacts/logo?${new URLSearchParams({ mailboxId, address })}` : undefined;
	return <ContactAvatar mailboxId={mailboxId} address={address} name={name} hasManagedAvatar={hasAvatar} managedAvatarUrl={managedAvatarUrl} fallbackAvatarUrl={fallback} className={className} />;
}
