import { getEmailAddressList, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";
import type { RecipientCandidate, RecipientDirectoryContact, RecipientDirectorySentMessage } from "./recipient-directory-types";

/** Addresses returned to the composer. The list is ranked, so the cut keeps the useful ones. */
export const MAX_DIRECTORY_ENTRIES = 1_000;
/** Addresses tracked while ranking; a mailbox with a fresh address on every message stops growing here. */
export const MAX_TRACKED_ADDRESSES = 20_000;

const SOURCE_RANK = { manual: 3, outbound: 2, inbound: 1 } as const;

function toTime(value: Date | number | null | undefined, now: number): number | null {
	if (value === null || value === undefined) return null;
	const time = value instanceof Date ? value.getTime() : value;
	if (!Number.isFinite(time)) return null;
	// A date after now counts as now, so a forged future Date header can't win the ranking.
	return Math.min(time, now);
}

/** Higher first: sends, the latest send, how the contact came to be, the latest sighting, then by label. */
export function compareRecipientCandidates(a: RecipientCandidate, b: RecipientCandidate): number {
	return (b.sends - a.sends)
		|| ((b.lastSentAt ?? 0) - (a.lastSentAt ?? 0))
		|| ((b.source ? SOURCE_RANK[b.source] : 0) - (a.source ? SOURCE_RANK[a.source] : 0))
		|| ((b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
		|| (a.name ?? a.email).localeCompare(b.name ?? b.email)
		|| a.email.localeCompare(b.email);
}

/**
 * The composer's address book: contacts, plus everyone the owner has sent mail
 * to, ranked as MailCraft ranks recipient suggestions. Blocked contacts and the
 * owner's own addresses are left out before the list is cut.
 */
export function buildRecipientDirectory({
	contacts,
	sent,
	own,
	now = Date.now(),
	limit = MAX_DIRECTORY_ENTRIES,
}: {
	contacts: readonly RecipientDirectoryContact[];
	sent: readonly RecipientDirectorySentMessage[];
	own: readonly string[];
	now?: number;
	limit?: number;
}): RecipientCandidate[] {
	const ownSet = new Set(own.map((address) => address.trim().toLowerCase()));
	const blocked = new Set<string>();
	const byEmail = new Map<string, RecipientCandidate>();
	const get = (email: string) => {
		let candidate = byEmail.get(email);
		if (!candidate && byEmail.size < MAX_TRACKED_ADDRESSES) {
			candidate = { email, name: null, sends: 0, lastSentAt: null, lastSeenAt: null, source: null };
			byEmail.set(email, candidate);
		}
		return candidate;
	};

	for (const contact of contacts) {
		const email = contact.email.trim().toLowerCase();
		if (!email.includes("@")) continue;
		if (contact.blocked) { blocked.add(email); continue; }
		const candidate = get(email);
		if (!candidate) continue;
		candidate.source = contact.source;
		candidate.name = contact.displayName?.trim() || candidate.name;
		candidate.lastSeenAt = toTime(contact.lastSeenAt, now);
	}

	for (const message of sent) {
		const sentAt = toTime(message.createdAt, now);
		const names = new Map<string, string>();
		const addresses = new Set<string>();
		for (const header of [message.toAddr, message.ccAddr, message.bccAddr]) {
			for (const entry of splitEmailAddressList(header)) {
				const [email] = getEmailAddressList(entry);
				if (!email) continue;
				addresses.add(email);
				const name = parseEmailAddressParts(entry).name;
				if (name && name.toLowerCase() !== email) names.set(email, name);
			}
		}
		for (const email of addresses) {
			const candidate = get(email);
			if (!candidate) continue;
			candidate.sends += 1;
			if (sentAt !== null && (candidate.lastSentAt === null || sentAt > candidate.lastSentAt)) candidate.lastSentAt = sentAt;
			// A contact's own name stands; the name used in sent mail fills a gap.
			if (!candidate.name && names.has(email)) candidate.name = names.get(email)!;
		}
	}

	return [...byEmail.values()]
		.filter((candidate) => !blocked.has(candidate.email) && !ownSet.has(candidate.email))
		.sort(compareRecipientCandidates)
		.slice(0, Math.max(0, limit));
}
