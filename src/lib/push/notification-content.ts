import { buildReadableSnippet, cleanSnippetText, needsSnippetRepair } from "@/lib/email/snippet";

function singleLine(value: string | null | undefined): string {
	return (value ?? "").replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
}

function shorten(value: string, maximum: number): string {
	const characters = Array.from(value);
	if (characters.length <= maximum) return value;
	const clipped = characters.slice(0, maximum - 1).join("");
	const boundary = clipped.lastIndexOf(" ");
	return (boundary > clipped.length * .75 ? clipped.slice(0, boundary) : clipped).trimEnd() + "…";
}

/** Factual preview only: no AI, remote resources, or extra work on the phone. */
export function buildMailPushContent(message: {
	from: string;
	fromName: string | null;
	subject: string | null;
	snippet: string | null;
	text: string | null;
	html: string | null;
}) {
	const title = shorten(singleLine(message.fromName) || singleLine(message.from) || "New email", 80);
	const subject = shorten(singleLine(message.subject), 100);
	let snippet = cleanSnippetText(message.snippet);
	if (!snippet || needsSnippetRepair(message.snippet)) {
		snippet = buildReadableSnippet(message.text, message.html, 220) || snippet;
	}
	const preview = shorten(singleLine(snippet), 180);
	// The subject stays first even where iOS collapses the body to one line.
	const body = [subject, preview && preview !== subject ? preview : ""].filter(Boolean).join("\n") || "New email";
	return { title, body };
}
