"use client";

import { useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useRecipientDirectory } from "@/components/compose/use-recipient-directory";
import { getEmailAddress } from "@/lib/email/address";
import { getSenderWarnings, readTrustedSenders, trustSender } from "./sender-warnings-utils";

/**
 * Says so above an incoming message when its sender is not who the name or the
 * address suggests. Nothing is blocked: the owner reads the reasons and decides,
 * and can mark the sender as fine so the question is not asked again.
 */
export function SenderWarningBanner({ fromAddr, replyTo, html }: { fromAddr: string; replyTo?: string | null; html?: string | null }) {
	const { t } = useLanguage();
	const { mailboxes } = useSelectedMailbox();
	const directory = useRecipientDirectory();
	const address = getEmailAddress(fromAddr).trim().toLowerCase();
	const [trusted, setTrusted] = useState<string | null>(null);
	const warnings = useMemo(() => {
		// Without the address book there is nothing to compare with, and every sender would be a stranger.
		if (directory.length === 0 || mailboxes.length === 0) return [];
		if (readTrustedSenders().includes(address)) return [];
		return getSenderWarnings({
			fromAddr, replyTo, html,
			facts: {
				known: directory.filter((candidate) => candidate.sends > 0 || candidate.source === "manual" || candidate.source === "outbound"),
				own: mailboxes.flatMap((mailbox) => (mailbox.senderAddresses?.length ? mailbox.senderAddresses : [`${mailbox.localPart}@${mailbox.hostname}`])),
				ownNames: mailboxes.map((mailbox) => mailbox.displayName ?? "").filter(Boolean),
				organisationDomains: mailboxes.map((mailbox) => mailbox.hostname),
			},
		});
	}, [address, directory, fromAddr, html, mailboxes, replyTo]);
	if (warnings.length === 0 || trusted === address) return null;

	return (
		<div role="alert" data-sender-warning className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
			<p className="flex items-center gap-2 font-semibold"><ShieldAlert aria-hidden="true" className="h-4 w-4 shrink-0" />{t("message.sender.title")}</p>
			<ul className="mt-1.5 space-y-1 break-words">
				{warnings.map((warning, index) => (
					<li key={index}>
						{warning.kind === "nameOfKnownPerson" ? t("message.sender.nameOfKnownPerson", { name: warning.name, known: warning.knownAddress, address })
							: warning.kind === "ownName" ? t("message.sender.ownName", { name: warning.name, address })
							: warning.kind === "lookalike" ? t("message.sender.lookalike", { address, like: warning.like })
							: warning.kind === "replyElsewhere" ? t("message.sender.replyElsewhere", { replyTo: warning.replyTo })
							: t("message.sender.deceptiveLink", { shown: warning.shown, target: warning.target })}
					</li>
				))}
			</ul>
			<p className="mt-1.5">{t("message.sender.advice")}</p>
			<button type="button" className="email-presentation-action mt-2 rounded-lg border border-amber-300 px-3 py-1.5 font-medium hover:bg-amber-100" onClick={() => { trustSender(address); setTrusted(address); }}>
				{t("message.sender.trust")}
			</button>
		</div>
	);
}
