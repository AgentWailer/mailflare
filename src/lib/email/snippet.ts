import { getLatestEmailContent, htmlToReadableText } from "./reply-content-utils";

const URL = /\b(?:https?:\/\/|www\.)[^\s<>"\]]+/gi;
const HTML_FALLBACK = /please\s+use\s+an?\s+email\s+client\s+supporting\s+html\s+email[^\n]*?(?:online|browser)\s*[:.!]?/gi;
const BROWSER_LINK = /(?:view\s+(?:this\s+)?(?:e-?mail|message)\s+(?:online|in\s+(?:your\s+)?browser)|(?:diese\s+e-?mail\s+)?im\s+browser\s+(?:ansehen|anzeigen|öffnen)|e-?mail\s+im\s+browser\s+(?:ansehen|anzeigen|öffnen))/gi;

/** Text only: suitable for both old stored snippets and freshly parsed mail. */
export function cleanSnippetText(value: string | null | undefined): string {
	return (value ?? "")
		.replace(/\\r\\n|\\[nrt]/g, "\n")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\(https?:\/\/[^)]*\)/gi, "$1")
		.replace(HTML_FALLBACK, " ")
		.replace(BROWSER_LINK, " ")
		.replace(URL, " ")
		.replace(/&nbsp;|&#(?:160|x0*a0);/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#(x[\da-f]+|\d+);/gi, (_match, number: string) => {
			const code = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
		})
		.replace(/[\u200b\u200e\u200f\u2060\ufeff\u00ad]/g, "")
		.replace(/^\s*(?:[^\n]{0,80}\b(?:logo|header image)\s*\n)+/i, "")
		.replace(/^[\s\[\]()*_>\-–—|:]+|[\s\[\]()*_>\-–—|:]+$/g, "")
		.replace(/\s+/g, " ").trim();
}

export function needsSnippetRepair(value: string | null): boolean {
	if (!value) return false;
	return /https?:\/\/|\bwww\.|supporting\s+html\s+email|\\[nr]/i.test(value);
}

export function buildReadableSnippet(text: string | null, html: string | null, max = 200): string {
	const plain = cleanSnippetText(getLatestEmailContent(text?.slice(0, 131072)));
	const useHtml = !plain || needsSnippetRepair(text) && plain.length < 40;
	const htmlText = useHtml ? cleanSnippetText(getLatestEmailContent(htmlToReadableText(html?.slice(0, 262144)))) : "";
	const source = htmlText.length > plain.length ? htmlText : plain;
	if (source.length <= max) return source;
	const clipped = source.slice(0, Math.max(0, max));
	const boundary = clipped.lastIndexOf(" ");
	return (boundary > max * 0.75 ? clipped.slice(0, boundary) : clipped.replace(/[\uD800-\uDBFF]$/, "")).trim();
}
