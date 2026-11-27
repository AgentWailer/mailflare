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
			// A public mail provider is nobody's organisation: anyone can open an address there under any name.
			const sharedDomain = isMailProviderDomain(senderDomain);
			const atSenderDomain = (entry: { email: string }) => registrableDomain(domainOf(entry.email.toLowerCase())) === senderDomain;
			const person = input.facts.known.find((entry) => nameKey(entry.name) === key && (sharedDomain || !atSenderDomain(entry)));
			const sameOrganisation = !sharedDomain && input.facts.known.some((entry) => nameKey(entry.name) === key && atSenderDomain(entry));
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
const TRUSTED_EVENT = "mailflare:trusted-senders-changed";
const MAX_TRUSTED = 500;

/** One list per account: what one person found in order says nothing for the next person at this browser. */
function trustedKey(scope: string): string {
	return scope ? `${TRUSTED_KEY}:${scope}` : TRUSTED_KEY;
}

/** The stored list as text, for a component to follow (`useSyncExternalStore`); empty when nothing is stored. */
export function readTrustedSendersText(scope = ""): string {
	try { return localStorage.getItem(trustedKey(scope)) ?? ""; } catch { return unstored.get(trustedKey(scope)) ?? ""; }
}

// Where the browser keeps nothing (storage blocked or full), a mark still holds until the page is closed.
const unstored = new Map<string, string>();

export function parseTrustedSenders(text: string): string[] {
	try {
		const value = JSON.parse(text || "[]");
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_TRUSTED) : [];
	} catch { return []; }
}

/** Senders the owner looked at and found in order, on this device. */
export function readTrustedSenders(scope = ""): string[] {
	return parseTrustedSenders(readTrustedSendersText(scope));
}

function writeTrustedSenders(scope: string, list: string[]) {
	const text = JSON.stringify(list.slice(0, MAX_TRUSTED));
	try { localStorage.setItem(trustedKey(scope), text); unstored.delete(trustedKey(scope)); } catch { unstored.set(trustedKey(scope), text); }
	// Every check of this sender on the page follows, not only the one that was pressed.
	if (typeof window !== "undefined") window.dispatchEvent(new Event(TRUSTED_EVENT));
}

export function trustSender(address: string, scope = ""): void {
	const key = address.trim().toLowerCase();
	if (key) writeTrustedSenders(scope, [key, ...readTrustedSenders(scope).filter((entry) => entry !== key)]);
}

/** Takes the mark back: the sender is warned about again. */
export function untrustSender(address: string, scope = ""): void {
	const key = address.trim().toLowerCase();
	writeTrustedSenders(scope, readTrustedSenders(scope).filter((entry) => entry !== key));
}

/** Tells `notify` when the list changes, here or in another tab. */
export function subscribeTrustedSenders(notify: () => void): () => void {
	const storage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(TRUSTED_KEY)) notify(); };
	window.addEventListener(TRUSTED_EVENT, notify);
	window.addEventListener("storage", storage);
	return () => { window.removeEventListener(TRUSTED_EVENT, notify); window.removeEventListener("storage", storage); };
}
