/**
 * Who a reply was addressed to when it was started: the people on the answered
 * message, who have already seen each other's addresses. Kept on this device
 * beside the draft, because the saved draft later also holds whoever the writer
 * added, and those must not count as having been there from the start.
 */
const KEY = "mailflare-reply-recipients";
const MAX_DRAFTS = 50;

function read(): Record<string, string[]> {
	try {
		const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string[]> : {};
	} catch { return {}; }
}

function write(entries: Record<string, string[]>) {
	try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(entries).slice(-MAX_DRAFTS)))); } catch { /* Without storage a reopened reply is asked about again. */ }
}

/**
 * The recipients a reply started with. `started` is given when the reply was
 * created just now; a reply reopened later answers from what was kept, and with
 * nobody when nothing was kept (another device), so the question is asked.
 */
export function replyStartRecipients(draftId: string, started: readonly string[] | null): string[] {
	const entries = read();
	if (!started) return Array.isArray(entries[draftId]) ? entries[draftId].filter((entry) => typeof entry === "string") : [];
	delete entries[draftId];
	write({ ...entries, [draftId]: [...started] });
	return [...started];
}

export function forgetReplyStartRecipients(draftId: string) {
	const entries = read();
	if (!(draftId in entries)) return;
	delete entries[draftId];
	write(entries);
}
