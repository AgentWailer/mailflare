import { getEmailAddress, joinEmailAddressList, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function isValidRecipient(entry: string): boolean {
	return EMAIL_RE.test(getEmailAddress(entry).trim());
}

/** Turn raw typed text into recipient entries, deduplicated by bare address. */
export function parseRecipientEntries(value: string, existing: string[] = []): string[] {
	const seen = new Set(existing.map((entry) => getEmailAddress(entry).toLowerCase()));
	const result: string[] = [];
	for (const entry of splitEmailAddressList(value)) {
		const key = getEmailAddress(entry).toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

export function recipientsToHeader(entries: string[]): string {
	return joinEmailAddressList(entries);
}

export function headerToRecipients(value: string | null | undefined): string[] {
	return parseRecipientEntries(value ?? "");
}

/** Short label for a chip: the display name if there is one, else the address. */
export function getRecipientLabel(entry: string): string {
	const parts = parseEmailAddressParts(entry);
	return parts.name && parts.name !== parts.address ? parts.name : parts.address;
}

export type RecipientField = "to" | "cc" | "bcc";
export type RecipientFields = Record<RecipientField, string[]>;
export const RECIPIENT_FIELDS: readonly RecipientField[] = ["to", "cc", "bcc"];

function recipientKey(entry: string): string {
	return getEmailAddress(entry).trim().toLowerCase();
}

/**
 * Moves one recipient (matched by bare address) from `from` into `to`, before
 * `beforeIndex` of the target list or at its end. Moving within one field
 * reorders it. When the target already holds the address, the source copy is
 * simply removed, so a move never duplicates a recipient. Unknown entries leave
 * the fields untouched.
 */
export function moveRecipient(
	fields: RecipientFields,
	entry: string,
	from: RecipientField,
	to: RecipientField,
	beforeIndex?: number,
): RecipientFields {
	const key = recipientKey(entry);
	const sourceIndex = fields[from].findIndex((item) => recipientKey(item) === key);
	if (!key || sourceIndex < 0) return fields;
	const moving = fields[from][sourceIndex];
	const source = fields[from].filter((_, index) => index !== sourceIndex);
	if (from === to) {
		// The index was counted with the moving entry still in its place.
		const wanted = beforeIndex === undefined ? source.length : beforeIndex > sourceIndex ? beforeIndex - 1 : beforeIndex;
		const position = Math.max(0, Math.min(wanted, source.length));
		// Dropped where it was: the same object tells callers nothing changed.
		if (position === sourceIndex) return fields;
		const next = [...source];
		next.splice(position, 0, moving);
		return { ...fields, [from]: next };
	}
	if (fields[to].some((item) => recipientKey(item) === key)) return { ...fields, [from]: source };
	const target = [...fields[to]];
	target.splice(Math.max(0, Math.min(beforeIndex ?? target.length, target.length)), 0, moving);
	return { ...fields, [from]: source, [to]: target };
}

/** Moves every listed address into Bcc, e.g. after the "outsiders would see each other" warning. */
export function moveRecipientsToBcc(fields: RecipientFields, addresses: readonly string[]): RecipientFields {
	let next = fields;
	const wanted = new Set(addresses.map(recipientKey));
	for (const field of ["to", "cc"] as const) {
		for (const entry of fields[field]) if (wanted.has(recipientKey(entry))) next = moveRecipient(next, entry, field, "bcc");
	}
	return next;
}
