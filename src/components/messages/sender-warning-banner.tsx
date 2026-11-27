"use client";

import { useMemo, useSyncExternalStore } from "react";
import { ShieldAlert } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useRecipientDirectoryState } from "@/components/compose/use-recipient-directory";
import { getEmailAddress } from "@/lib/email/address";
import { useCurrentUser } from "@/hooks/use-current-user";
import { getSenderWarnings, parseTrustedSenders, readTrustedSendersText, subscribeTrustedSenders, trustSender, untrustSender } from "./sender-warnings-utils";

/**
 * Says so above an incoming message when its sender is not who the name or the
 * address suggests. Nothing is blocked: the owner reads the reasons and decides,
 * and can mark the sender as fine so the question is not asked again. A sender
 * marked that way keeps a quiet line saying so, with the way to be warned again.
 */
export function SenderWarningBanner({ fromAddr, replyTo, html }: { fromAddr: string; replyTo?: string | null; html?: string | null }) {
	const { t } = useLanguage();
	const { mailboxes } = useSelectedMailbox();
	const { directory, loaded } = useRecipientDirectoryState();
	const address = getEmailAddress(fromAddr).trim().toLowerCase();
	// The people at one browser keep separate lists, also when they share the same mailboxes.
	const user = useCurrentUser();
	// Until it is known who is reading, nobody's marks count and none can be made.
	const scope = user ? `user:${user.id}` : null;
	// Followed as a store: marking a sender on one message answers every check of that sender on the page.
	const stored = useSyncExternalStore(subscribeTrustedSenders, () => (scope ? readTrustedSendersText(scope) : ""), () => "");
	const warnings = useMemo(() => {
		// Wait for the address book's answer, so a known correspondent is not questioned for a moment.
		// An empty or unreachable one still leaves the checks that need nobody to compare with.
		if (!loaded || mailboxes.length === 0) return [];
		return getSenderWarnings({
			fromAddr, replyTo, html,
			facts: {
				known: directory.filter((candidate) => candidate.sends > 0 || candidate.source === "manual" || candidate.source === "outbound"),
				own: mailboxes.flatMap((mailbox) => (mailbox.senderAddresses?.length ? mailbox.senderAddresses : [`${mailbox.localPart}@${mailbox.hostname}`])),
				ownNames: mailboxes.map((mailbox) => mailbox.displayName ?? "").filter(Boolean),
				organisationDomains: mailboxes.map((mailbox) => mailbox.hostname),
			},
		});
	}, [directory, fromAddr, html, loaded, mailboxes, replyTo]);
	const trusted = useMemo(() => warnings.length > 0 && parseTrustedSenders(stored).includes(address), [address, stored, warnings.length]);
	if (warnings.length === 0) return null;

	if (trusted) {
		return (
			<p role="status" data-sender-trusted className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-600">
				<span className="min-w-0 break-words">{t("message.sender.trusted", { address })}</span>
				<button type="button" className="email-presentation-action rounded-lg border border-neutral-300 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-100" onClick={() => { if (scope) untrustSender(address, scope); }}>
					{t("message.sender.warnAgain")}
				</button>
			</p>
		);
	}

	return (
		<div role="alert" data-sender-warning className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
			<p className="flex items-center gap-2 font-semibold"><ShieldAlert aria-hidden="true" className="h-4 w-4 shrink-0" />{t("message.sender.title")}</p>
			<ul className="mt-1.5 space-y-1 break-words">
				{warnings.map((warning, index) => (
					<li key={index}>
						{warning.kind === "nameOfKnownPerson" ? t("message.sender.nameOfKnownPerson", { name: warning.name, known: warning.knownAddress, address })
							: warning.kind === "nameIsOtherAddress" ? t("message.sender.nameIsOtherAddress", { shown: warning.shown, address })
							: warning.kind === "ownName" ? t("message.sender.ownName", { name: warning.name, address })
							: warning.kind === "lookalike" ? t("message.sender.lookalike", { address, like: warning.like })
							: warning.kind === "replyElsewhere" ? t("message.sender.replyElsewhere", { replyTo: warning.replyTo })
							: t("message.sender.deceptiveLink", { shown: warning.shown, target: warning.target })}
					</li>
				))}
			</ul>
			<p className="mt-1.5">{t("message.sender.advice")}</p>
			{scope && (
				<button type="button" className="email-presentation-action mt-2 rounded-lg border border-amber-300 px-3 py-1.5 font-medium hover:bg-amber-100" onClick={() => trustSender(address, scope)}>
					{t("message.sender.trust")}
				</button>
			)}
		</div>
	);
}
