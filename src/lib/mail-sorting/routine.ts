import { getEmailAddress } from "@/lib/email/address";
import type { SortingDecision } from "./categories";
/** Narrow shortcuts for routine bulk mail; personal/security/transaction subjects stay with CLEF. */
export function resolveRoutineMail(input: {
	sender: string;
	subject?: string | null;
	text?: string | null;
	headers?: Record<string, string>;
}): SortingDecision | null {
	const listMail = Object.keys(input.headers ?? {}).some(
		(key) => key.toLowerCase() === "list-unsubscribe",
	);
	if (!listMail) return null;
	const subject = input.subject?.toLowerCase() ?? "";
	if (
		/\b(security|sicherheit|anmeldung|login|password|passwort|invoice|rechnung|receipt|quittung|payment|zahlung|bestellbestätigung|order confirmation)\b|message from|nachricht von|sent you a message|hat dir eine nachricht/.test(
			subject,
		)
	)
		return null;
	const text = input.text?.toLowerCase().slice(0, 6000) ?? "";
	if (
		/\b(sale|discount|rabatt|gutschein|coupon|black friday|sonderaktion)\b|\d+\s*%/.test(
			subject,
		) &&
		/\b(buy|shop|kaufen|sparen|discount|rabatt|sale)\b/.test(text)
	)
		return { category: "promotions", source: "rule", reason: "marketing_list" };
	const address = getEmailAddress(input.sender).trim().toLowerCase();
	const domain = address.slice(address.lastIndexOf("@") + 1);
	if (
		(domain === "linkedin.com" || domain.endsWith(".linkedin.com")) &&
		/digest|profilbesuch|profile views|kontaktvorschl|suggestions|dein netzwerk|your network|weekly|wöchentlich/.test(
			subject,
		)
	)
		return { category: "social", source: "rule", reason: "social_digest" };
	return null;
}
