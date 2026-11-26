import { splitEmailAddressList } from "@/lib/email/address";

/** What a link or another program asks the composer to start with. */
export type ComposePrefill = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };

/** Bounds on what a link may put into a message: a link is outside input. */
const MAX_LINK_LENGTH = 64_000;
const MAX_RECIPIENTS_PER_LINE = 50;
const MAX_SUBJECT = 500;
const MAX_BODY = 50_000;

function decode(value: string): string {
	// In a mailto link a plus sign is a plus sign, not a space (RFC 6068).
	try { return decodeURIComponent(value); } catch { return value; }
}

function addresses(value: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of splitEmailAddressList(value)) {
		// Only real addresses: a link must not be able to plant text that merely looks like one.
		if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(entry) && !/<[^\s@<>"]+@[^\s@<>"]+>$/.test(entry)) continue;
		const key = entry.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
		if (result.length >= MAX_RECIPIENTS_PER_LINE) break;
	}
	return result;
}

function build(fields: { to: string[]; cc: string; bcc: string; subject: string; body: string }): ComposePrefill | null {
	const prefill: ComposePrefill = {
		to: addresses(fields.to.join(",")),
		cc: addresses(fields.cc),
		bcc: addresses(fields.bcc),
		// A subject is one line; control characters have no place in it.
		subject: fields.subject.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_SUBJECT),
		body: fields.body.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_BODY),
	};
	return prefill.to.length || prefill.cc.length || prefill.bcc.length || prefill.subject || prefill.body ? prefill : null;
}

/**
 * A `mailto:` link as the start of a message (RFC 6068): the addresses, and the
 * `to`, `cc`, `bcc`, `subject` and `body` it names. Every other field a link
 * may carry (attachments, arbitrary headers) is ignored. Null when the text is
 * no mailto link or names nothing.
 */
export function parseMailto(value: string | null | undefined): ComposePrefill | null {
	const link = (value ?? "").trim();
	if (link.length > MAX_LINK_LENGTH || !/^mailto:/i.test(link)) return null;
	const rest = link.slice("mailto:".length);
	const question = rest.indexOf("?");
	const fields = { to: [decode(question < 0 ? rest : rest.slice(0, question))], cc: "", bcc: "", subject: "", body: "" };
	if (question >= 0) {
		for (const pair of rest.slice(question + 1).split("&").slice(0, 100)) {
			const equals = pair.indexOf("=");
			const name = decode(equals < 0 ? pair : pair.slice(0, equals)).toLowerCase();
			const text = decode(equals < 0 ? "" : pair.slice(equals + 1));
			if (name === "to") fields.to.push(text);
			else if (name === "cc") fields.cc = fields.cc ? `${fields.cc},${text}` : text;
			else if (name === "bcc") fields.bcc = fields.bcc ? `${fields.bcc},${text}` : text;
			else if (name === "subject" && !fields.subject) fields.subject = text;
			else if (name === "body" && !fields.body) fields.body = text;
		}
	}
	return build(fields);
}

/**
 * The start of a message named by the compose page's address: `?mailto=` holds a
 * whole mailto link (how the browser hands one over once Mailflare is the mail
 * program), `?to=&subject=&body=` name the parts directly.
 */
export function prefillFromSearchParams(params: { get(name: string): string | null }): ComposePrefill | null {
	const link = params.get("mailto");
	if (link) return parseMailto(link);
	return build({ to: [params.get("to") ?? ""], cc: params.get("cc") ?? "", bcc: params.get("bcc") ?? "", subject: params.get("subject") ?? "", body: params.get("body") ?? "" });
}

/** Where the browser sends a clicked mailto link once Mailflare handles them. `%s` is the link. */
export const MAILTO_HANDLER_PATH = "/compose?mailto=%s";
