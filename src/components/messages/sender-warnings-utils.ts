import { findLookalike, prepareSendWarningFacts } from "@/components/compose/send-warnings-utils";
import { foldForSearch } from "@/components/compose/recipient-suggest-utils";
import { getEmailAddressList, parseEmailAddressParts } from "@/lib/email/address";
import { addressesWrittenIn, isMailProviderDomain, registrableDomain, withoutInvisible } from "@/lib/email/confusables";
import type { SenderCheckInput, SenderWarning } from "./sender-warnings-types";

/**
 * Reasons to look twice at who a message is from, modelled after MailCraft's
 * sender warnings: a known person's name on a strange address (the usual
 * "your boss asks for a transfer" fraud), a lookalike address or domain, and
 * replies that would go to a throwaway mailbox. Pure: everything is passed in.
 */

/** Links read for the deceptive-link check; a newsletter with thousands is not scanned in full. */
const MAX_LINKS = 300;

/** A person's name as it is compared: without case, accents, punctuation and titles. */
export function nameKey(name: string | null | undefined): string | null {
	const words = foldForSearch(withoutInvisible(name ?? "")).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	// One word ("Info", "Support", "Anna") is shared by too many senders to mean one person.
	if (words.length < 2 || words.join("").length < 5) return null;
	return words.sort().join(" ");
}

function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The site a link's text names, when the text is written as a web address; null for ordinary words. */
function siteNamedBy(text: string): string | null {
	const cleaned = withoutInvisible(text).trim();
	if (!cleaned || cleaned.length > 200 || /\s/.test(cleaned.replace(/^https?:\/\/\S+$/i, ""))) {
		// Words around an address ("here in the portal: https://…") still name that site.
		const inside = cleaned.match(/https?:\/\/([^\s/?#"'<>]+)/i);
		return inside ? inside[1].toLowerCase().replace(/^www\./, "").replace(/[.,;:!)]+$/, "") : null;
	}
	const match = cleaned.match(/^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+\p{L}{2,})(?:[/:?#]\S*)?$/iu);
	return match ? match[1].toLowerCase().replace(/^www\./, "") : null;
}

/** The first link whose visible text names one site while it leads to another. */
export function findDeceptiveLink(html: string | null | undefined): { shown: string; target: string } | null {
	if (!html || typeof DOMParser === "undefined") return null;
	const doc = new DOMParser().parseFromString(html.slice(0, 2_000_000), "text/html");
	let read = 0;
	for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
		if (++read > MAX_LINKS) break;
		const href = anchor.getAttribute("href") ?? "";
		if (!/^https?:\/\//i.test(href)) continue;
		let target: string;
		try { target = new URL(href).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
		const shown = siteNamedBy(anchor.textContent ?? "");
		if (!shown || !target) continue;
		if (registrableDomain(shown) !== registrableDomain(target)) return { shown, target };
	}
	return null;
}

/** What to say about the sender of an incoming message; empty for the ordinary case. */
export function getSenderWarnings(input: SenderCheckInput): SenderWarning[] {
	const sender = parseEmailAddressParts(input.fromAddr);
	const [address] = getEmailAddressList(input.fromAddr);
	if (!address || !address.includes("@")) return [];
	const own = new Set(input.facts.own.map((entry) => entry.trim().toLowerCase()));
	const knownAddresses = new Set(input.facts.known.map((entry) => entry.email.trim().toLowerCase()));
	// Somebody the owner writes to, and the owner's own addresses, are who they say they are.
	if (own.has(address) || knownAddresses.has(address)) return [];

	const warnings: SenderWarning[] = [];
	// `"boss@firm.example" <someone@else.example>`: mail programs show the name large and the address small.
	const written = addressesWrittenIn(sender.name).filter((entry) => entry !== address);
	// Say the one the reader would recognise: an address they know, else the last one written.
	const shown = written.find((entry) => own.has(entry) || knownAddresses.has(entry)) ?? written.at(-1);
	if (shown) warnings.push({ kind: "nameIsOtherAddress", shown });
	const senderDomain = registrableDomain(domainOf(address));
	const key = nameKey(sender.name);
	if (key) {
		if (input.facts.ownNames.some((name) => nameKey(name) === key) && !input.facts.organisationDomains.some((domain) => registrableDomain(domain) === senderDomain)) {
			warnings.push({ kind: "ownName", name: sender.name!.trim() });
		} else {
			// The same name at the same organisation is a second address of that person, not somebody else.
			const person = input.facts.known.find((entry) => nameKey(entry.name) === key && registrableDomain(domainOf(entry.email.toLowerCase())) !== senderDomain);
			const sameOrganisation = input.facts.known.some((entry) => nameKey(entry.name) === key && registrableDomain(domainOf(entry.email.toLowerCase())) === senderDomain);
			if (person && !sameOrganisation) warnings.push({ kind: "nameOfKnownPerson", name: sender.name!.trim(), knownAddress: person.email.toLowerCase() });
		}
	}

	const like = findLookalike(prepareSendWarningFacts({ known: input.facts.known.map((entry) => entry.email), own: input.facts.own, organisationDomains: input.facts.organisationDomains }), address);
	if (like) warnings.push({ kind: "lookalike", like });

	const [replyTo] = getEmailAddressList(input.replyTo);
	if (replyTo && replyTo !== address && !own.has(replyTo) && !knownAddresses.has(replyTo)) {
		const replyDomain = registrableDomain(domainOf(replyTo));
		if (replyDomain !== senderDomain && isMailProviderDomain(replyDomain) && !isMailProviderDomain(senderDomain)) warnings.push({ kind: "replyElsewhere", replyTo });
	}

	// Marketing mail routes honest links through tracking sites, so a link alone says nothing.
	// Beside another warning it is the last piece of the usual fraud.
	if (warnings.length > 0) {
		const link = findDeceptiveLink(input.html);
		if (link) warnings.push({ kind: "deceptiveLink", ...link });
	}
	return warnings;
}

const TRUSTED_KEY = "mailflare-trusted-senders";
const MAX_TRUSTED = 500;

/** Senders the owner looked at and found in order, on this device. */
export function readTrustedSenders(): string[] {
	try {
		const value = JSON.parse(localStorage.getItem(TRUSTED_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_TRUSTED) : [];
	} catch { return []; }
}

export function trustSender(address: string): void {
	const key = address.trim().toLowerCase();
	if (!key) return;
	try { localStorage.setItem(TRUSTED_KEY, JSON.stringify([key, ...readTrustedSenders().filter((entry) => entry !== key)].slice(0, MAX_TRUSTED))); } catch { /* Asking again next time is fine. */ }
}
