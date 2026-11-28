import type { RecipientCandidate } from "./recipient-directory-types";

/** Lower case without accents, so `gvoz` finds Gvožđar and `muller` finds Müller. */
export function foldForSearch(value: string): string {
	// Lower case first: Đ, Ł and ẞ have no accent to strip and are only matched in their small form.
	return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/ß/g, "ss").replace(/ł/g, "l");
}

function words(value: string): string[] {
	return foldForSearch(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Whether `query` (the start of a name, of a word of it, or of an address)
 * fits the candidate. With an `@` it is an address being typed and is only
 * compared with addresses. Several words must start words of the name in order.
 */
export function matchesRecipientQuery(candidate: Pick<RecipientCandidate, "email" | "name">, query: string): boolean {
	const typed = foldForSearch(query.trim());
	if (!typed || typed.length > 200) return false;
	const email = foldForSearch(candidate.email);
	if (email.startsWith(typed)) return true;
	if (typed.includes("@")) return false;
	const name = candidate.name ? foldForSearch(candidate.name) : "";
	if (name.startsWith(typed)) return true;
	const wanted = words(typed);
	if (wanted.length === 0) return false;
	const nameWords = [...words(candidate.name ?? ""), ...words(candidate.email.split("@")[0] ?? "")];
	let position = 0;
	for (const word of wanted) {
		while (position < nameWords.length && !nameWords[position].startsWith(word)) position += 1;
		if (position === nameWords.length) return false;
		position += 1;
	}
	return true;
}

/** At most `limit` candidates for `query`, in directory order, without addresses already chosen. */
export function suggestRecipients(
	directory: readonly RecipientCandidate[],
	query: string,
	exclude: ReadonlySet<string>,
	limit = 6,
): RecipientCandidate[] {
	const result: RecipientCandidate[] = [];
	if (!query.trim()) return result;
	for (const candidate of directory) {
		if (result.length >= limit) break;
		if (exclude.has(candidate.email.toLowerCase())) continue;
		if (matchesRecipientQuery(candidate, query)) result.push(candidate);
	}
	return result;
}
