import { getEmailAddress } from "@/lib/email/address";
import {
	differsByDigitsOnly,
	isMailProviderDomain,
	mailboxLocalPart,
	registrableDomain,
	skeleton,
	withinOneEdit,
	withoutInvisible,
} from "@/lib/email/confusables";
import type { SendWarning, SendWarningFacts, SendWarningInput } from "./send-warnings-types";

/**
 * Checks before a message goes, modelled after MailCraft's send warnings
 * (#509 there): a recipient that looks like somebody the owner writes to but
 * isn't, people outside the organisation who would see each other's
 * addresses, and an attachment the text mentions but the message lacks.
 * Pure and bounded: everything it needs is passed in.
 */

/** The fewest outsiders, and the fewest domains they are at, that are asked about. */
export const MIN_OUTSIDERS = 5;
export const MIN_OUTSIDE_DOMAINS = 2;
/** Different recipients looked at; past this the message is asked about as such. */
export const MAX_CHECKED_RECIPIENTS = 1_000;
/** Lookalikes reported, outsiders named. */
export const MAX_REPORTED = 20;
/** A name shorter than this is never measured one character away: short words are one letter from many others. */
export const MIN_LOOKALIKE_NAME = 5;
/** Known addresses compared; the directory is ranked, so these are the ones written to most. */
const MAX_KNOWN = 5_000;

type KnownLocal = { address: string; mailbox: string; skeleton: string };
type PreparedFacts = {
	known: Set<string>;
	own: Set<string>;
	organisation: string[];
	domains: Set<string>;
	domainsBySkeleton: Map<string, string>;
	domainList: string[];
	locals: Map<string, KnownLocal[]>;
};

function splitAddress(value: string): { local: string; domain: string } | null {
	const address = withoutInvisible(getEmailAddress(value)).trim().toLowerCase();
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) return null;
	return { local: address.slice(0, at), domain: address.slice(at + 1).replace(/\.$/, "") };
}

function keyOf(value: string): string | null {
	const parts = splitAddress(value);
	return parts ? `${parts.local}@${parts.domain}` : null;
}

export function prepareSendWarningFacts(facts: SendWarningFacts): PreparedFacts {
	const prepared: PreparedFacts = {
		known: new Set(), own: new Set(), domains: new Set(), domainsBySkeleton: new Map(), domainList: [], locals: new Map(),
		organisation: [...new Set(facts.organisationDomains.map((domain) => domain.trim().toLowerCase()).filter((domain) => domain && !isMailProviderDomain(domain)))],
	};
	const remember = (value: string) => {
		const parts = splitAddress(value);
		if (!parts) return null;
		const domain = registrableDomain(parts.domain);
		if (!prepared.domains.has(domain)) {
			prepared.domains.add(domain);
			prepared.domainList.push(domain);
			const shape = skeleton(domain);
			if (!prepared.domainsBySkeleton.has(shape)) prepared.domainsBySkeleton.set(shape, domain);
		}
		const mailbox = mailboxLocalPart(parts.local, parts.domain);
		const list = prepared.locals.get(parts.domain) ?? [];
		if (list.length < MAX_KNOWN) list.push({ address: `${parts.local}@${parts.domain}`, mailbox, skeleton: skeleton(mailbox) });
		prepared.locals.set(parts.domain, list);
		return `${parts.local}@${parts.domain}`;
	};
	for (const value of facts.own.slice(0, MAX_KNOWN)) { const key = remember(value); if (key) prepared.own.add(key); }
	for (const value of facts.known.slice(0, MAX_KNOWN)) { const key = remember(value); if (key) prepared.known.add(key); }
	return prepared;
}

function firstLabel(domain: string): string {
	return domain.split(".")[0] ?? domain;
}

/** The known domain or address `value` reads like but isn't, or null. */
export function findLookalike(facts: PreparedFacts, value: string): string | null {
	const parts = splitAddress(value);
	if (!parts) return null;
	const key = `${parts.local}@${parts.domain}`;
	if (facts.known.has(key) || facts.own.has(key)) return null;

	// Before the @: the same domain, a mailbox one letter away from a known one.
	const mailbox = mailboxLocalPart(parts.local, parts.domain);
	const shape = skeleton(mailbox);
	for (const theirs of facts.locals.get(parts.domain) ?? []) {
		if (theirs.mailbox === mailbox) return null; // A +tag or Gmail dots of a known person are theirs.
	}
	for (const theirs of facts.locals.get(parts.domain) ?? []) {
		if (Array.from(theirs.mailbox).length < MIN_LOOKALIKE_NAME) continue;
		if (shape === theirs.skeleton || (withinOneEdit(mailbox, theirs.mailbox) && !differsByDigitsOnly(mailbox, theirs.mailbox))) return theirs.address;
	}

	// The domain: one look-alike character or one edit away from a known correspondent's.
	const mine = registrableDomain(parts.domain);
	if (facts.domains.has(mine) || isMailProviderDomain(mine)) return null;
	if (Array.from(firstLabel(mine)).length < MIN_LOOKALIKE_NAME) return null;
	const like = facts.domainsBySkeleton.get(skeleton(mine));
	if (like && like !== mine) return like;
	const length = Array.from(mine).length;
	for (const theirs of facts.domainList) {
		if (Math.abs(Array.from(theirs).length - length) > 1) continue;
		if (Array.from(firstLabel(theirs)).length < MIN_LOOKALIKE_NAME) continue;
		if (withinOneEdit(mine, theirs) && !differsByDigitsOnly(mine, theirs)) return theirs;
	}
	return null;
}

function isOutsider(facts: PreparedFacts, value: string): boolean {
	const parts = splitAddress(value);
	if (!parts || facts.organisation.length === 0) return false;
	if (facts.own.has(`${parts.local}@${parts.domain}`)) return false;
	return !facts.organisation.some((ours) => parts.domain === ours || parts.domain.endsWith(`.${ours}`));
}

/** Words that say something is attached, in the languages Mailflare is mostly written in. */
const ATTACHMENT_WORDS = /(?:^|[^\p{L}])(anhang|anhänge|anhängen|angehängt|anbei|beigefügt|beiliegend|im anhang|attached|attachment|attachments|enclosed|i(?:'| ha)ve attached|ci-joint|pièce jointe|pièces jointes|adjunto|adjunta|allegato|allegati|in bijlage|bijgevoegd|załącznik|w załączniku)(?=$|[^\p{L}])/iu;

export function mentionsAttachment(text: string): boolean {
	return ATTACHMENT_WORDS.test(text.slice(0, 50_000));
}

/** The warnings for a message, lookalikes first in recipient order. Never throws. */
export function getSendWarnings(input: SendWarningInput): SendWarning[] {
	const facts = prepareSendWarningFacts(input.facts);
	const warnings: SendWarning[] = [];
	const unique: { value: string; key: string; visible: boolean }[] = [];
	const indexByKey = new Map<string, number>();
	let tooMany = false;
	for (const [field, list] of [["to", input.to], ["cc", input.cc], ["bcc", input.bcc]] as const) {
		for (const value of list) {
			const key = keyOf(value);
			if (!key) continue;
			const existing = indexByKey.get(key);
			if (existing !== undefined) { if (field !== "bcc") unique[existing].visible = true; continue; }
			if (unique.length >= MAX_CHECKED_RECIPIENTS) { tooMany = true; continue; }
			indexByKey.set(key, unique.length);
			unique.push({ value, key, visible: field !== "bcc" });
		}
	}

	let reported = 0;
	for (const recipient of unique) {
		if (reported >= MAX_REPORTED) break;
		const like = findLookalike(facts, recipient.value);
		if (like) { warnings.push({ kind: "lookalike", address: recipient.key, like }); reported += 1; }
	}

	const outsiders = unique.filter((recipient) => recipient.visible && isOutsider(facts, recipient.value));
	const seen = new Set((input.seen ?? []).map(keyOf).filter((key): key is string => !!key));
	const outsideDomains = new Set(outsiders.map((recipient) => recipient.key.slice(recipient.key.lastIndexOf("@") + 1)));
	if (outsiders.length >= MIN_OUTSIDERS && outsideDomains.size >= MIN_OUTSIDE_DOMAINS && !outsiders.every((recipient) => seen.has(recipient.key))) {
		warnings.push({ kind: "outsiders", count: outsiders.length, domains: outsideDomains.size, addresses: outsiders.slice(0, MAX_CHECKED_RECIPIENTS).map((recipient) => recipient.key) });
	}

	if (!input.hasAttachments && input.bodyText && mentionsAttachment(input.bodyText)) warnings.push({ kind: "missingAttachment" });
	if (tooMany) warnings.push({ kind: "tooManyRecipients", checked: MAX_CHECKED_RECIPIENTS });
	return warnings;
}
