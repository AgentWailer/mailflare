import { htmlToReadableText } from "./reply-content-utils";

/** Match the readable body once, consistently for live and saved messages. */
export function ruleMessageContent(text?: string | null, html?: string | null, snippet?: string | null): string {
 return text?.trim() || htmlToReadableText(html).trim() || snippet?.trim() || "";
}
