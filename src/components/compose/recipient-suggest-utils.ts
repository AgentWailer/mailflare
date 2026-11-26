import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import type { RecipientCandidate } from "@/lib/contacts/recipient-directory-types";

export { foldForSearch, matchesRecipientQuery, suggestRecipients } from "@/lib/contacts/recipient-match";

/** The chip text a chosen suggestion becomes. */
export function candidateToRecipient(candidate: Pick<RecipientCandidate, "email" | "name">): string {
	const name = candidate.name?.trim();
	return name && name.toLowerCase() !== candidate.email.toLowerCase() ? formatEmailAddress(candidate.email, name) : candidate.email;
}

/** Lower-cased bare addresses of recipient entries, for excluding them from suggestions. */
export function recipientAddressSet(...lists: readonly (readonly string[])[]): Set<string> {
	const set = new Set<string>();
	for (const list of lists) for (const entry of list) set.add(getEmailAddress(entry).trim().toLowerCase());
	return set;
}
