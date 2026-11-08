/** Splits "Delete this? It cannot be undone." into a short question title and its consequences. */
export function questionParts(text: string): { title: string; description?: string } {
	const end = text.indexOf("? ");
	if (end < 0) return { title: text };
	return { title: text.slice(0, end + 1), description: text.slice(end + 2).trim() || undefined };
}
