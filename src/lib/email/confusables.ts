/**
 * Helpers for spotting addresses that read like another one. The rules follow
 * MailCraft's send warnings (MIT OR Apache-2.0, github.com/UCSLabs/mailcraft):
 * characters that look alike are folded to one "skeleton", and two strings of
 * letters count as neighbours when one edit (insert, delete, replace or swap of
 * two adjacent characters) turns one into the other. Everything here is pure
 * and bounded, so it can run on every send without a lookup.
 */

/** The most characters of one string compared; longer input is cut, never scanned in full. */
export const MAX_COMPARED_CHARS = 256;

const PROTOTYPES: Record<string, string> = {
	// Digits that pass for letters.
	"0": "o", "1": "l",
	// Cyrillic.
	"а": "a", "ӑ": "a", "ӓ": "a", "с": "c", "ҫ": "c", "ԁ": "d", "е": "e", "ё": "e", "ӗ": "e", "һ": "h",
	"і": "i", "ї": "i", "ӏ": "l", "ј": "j", "к": "k", "о": "o", "ӧ": "o", "р": "p", "ԛ": "q", "ѕ": "s",
	"у": "y", "ў": "y", "ү": "y", "ԝ": "w", "х": "x", "ҳ": "x",
	// Greek.
	"α": "a", "ά": "a", "β": "b", "γ": "y", "ε": "e", "έ": "e", "η": "n", "ή": "n", "ι": "i", "ί": "i",
	"ϊ": "i", "ΐ": "i", "κ": "k", "ν": "v", "ο": "o", "ό": "o", "ρ": "p", "τ": "t", "υ": "u", "ύ": "u",
	"ϋ": "u", "χ": "x", "ω": "w", "ώ": "w",
	// Latin letters of their own shape.
	"ɑ": "a", "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ŀ": "l", "ß": "ss",
};

/** Characters that draw nothing: zero-width spaces and joiners, soft hyphens, direction marks. */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;

/** `text` without the characters that draw nothing, cut to {@link MAX_COMPARED_CHARS}. */
export function withoutInvisible(text: string): string {
	return Array.from(text.replace(INVISIBLE, "")).slice(0, MAX_COMPARED_CHARS).join("");
}

/**
 * The look of `text`: lower case, accents dropped, full-width forms narrowed,
 * look-alike letters and digits replaced by the Latin letter they pass for,
 * and the letter pairs that read as one letter (`rn` → `m`, `vv` → `w`,
 * `cl` → `d`) joined.
 */
export function skeleton(text: string): string {
	let out = "";
	for (const raw of Array.from(withoutInvisible(text).normalize("NFKC").toLowerCase())) {
		const prototype = PROTOTYPES[raw];
		if (prototype) { out += prototype; continue; }
		const base = raw.normalize("NFD").replace(/\p{M}/gu, "");
		out += PROTOTYPES[base] ?? base;
	}
	return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
}

/** Whether `a` and `b` differ by at most one insert, delete, replace or adjacent swap. Linear. */
export function withinOneEdit(a: string, b: string): boolean {
	const left = Array.from(a).slice(0, MAX_COMPARED_CHARS), right = Array.from(b).slice(0, MAX_COMPARED_CHARS);
	const [short, long] = left.length <= right.length ? [left, right] : [right, left];
	const gap = long.length - short.length;
	if (gap > 1) return false;
	if (gap === 0) {
		const differ: number[] = [];
		for (let index = 0; index < short.length && differ.length < 3; index++) if (short[index] !== long[index]) differ.push(index);
		if (differ.length <= 1) return true;
		if (differ.length > 2) return false;
		const [i, j] = differ;
		return j === i + 1 && short[i] === long[j] && short[j] === long[i];
	}
	let i = 0;
	while (i < short.length && short[i] === long[i]) i++;
	for (; i < short.length; i++) if (short[i] !== long[i + 1]) return false;
	return true;
}

/** Whether `a` and `b`, of the same length, differ only where both have a digit (`sales1`, `sales2`). */
export function differsByDigitsOnly(a: string, b: string): boolean {
	const left = Array.from(a), right = Array.from(b);
	if (left.length !== right.length) return false;
	let differs = false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] === right[index]) continue;
		if (!/\d/.test(left[index]) || !/\d/.test(right[index])) return false;
		differs = true;
	}
	return differs;
}

/** Second-level labels under which organisations register their names (`example.co.uk`). */
const SECOND_LEVEL_SUFFIXES = new Set([
	"co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au",
	"co.nz", "org.nz", "co.jp", "or.jp", "ne.jp", "com.br", "com.tr", "com.cn", "com.hk", "com.sg",
	"co.in", "co.za", "co.at", "or.at", "gv.at", "co.il", "co.kr", "com.mx", "com.ar", "com.pl", "com.es",
]);

/** The part of `domain` its owner registered: `mail.example.co.uk` → `example.co.uk`. */
export function registrableDomain(domain: string): string {
	const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Large public mail providers: their addresses belong to people, not to one organisation. */
const MAIL_PROVIDERS = new Set([
	"gmail.com", "googlemail.com", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de",
	"msn.com", "yahoo.com", "yahoo.de", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "aol.de",
	"gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com", "web.de", "t-online.de", "freenet.de", "posteo.de",
	"posteo.net", "mailbox.org", "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.io", "zoho.com",
	"yandex.com", "yandex.ru", "mail.ru", "fastmail.com", "hey.com", "arcor.de", "vodafone.de", "1und1.de",
]);

export function isMailProviderDomain(domain: string): boolean {
	return MAIL_PROVIDERS.has(registrableDomain(domain));
}

/** Domains whose mailboxes ignore dots before the @. */
const DOTS_IGNORED = new Set(["gmail.com", "googlemail.com"]);

/** The mailbox a local part reaches: lower case, without a `+tag`, without the dots Gmail ignores. */
export function mailboxLocalPart(local: string, domain: string): string {
	let value = withoutInvisible(local).toLowerCase();
	const plus = value.indexOf("+");
	if (plus > 0) value = value.slice(0, plus);
	if (DOTS_IGNORED.has(registrableDomain(domain))) value = value.replace(/\./g, "");
	return value;
}
