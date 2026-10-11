import { getEmailAddress } from "@/lib/email/address";
import type { SortingDecision } from "./categories";

type RoutineInput = { sender: string; subject?: string | null; text?: string | null; headers?: Record<string, string> };

export function isBulkMail(input: Pick<RoutineInput, "headers">): boolean {
	return Object.entries(input.headers ?? {}).some(([key, value]) =>
		key.toLowerCase() === "list-unsubscribe" || key.toLowerCase() === "list-id" ||
		(key.toLowerCase() === "precedence" && /^(bulk|list)$/i.test(value.trim())),
	);
}

/** Never quarantine a conversation, security alert or transaction merely because it has list headers. */
export function isProtectedRoutineMail(input: RoutineInput): boolean {
	const subject = input.subject?.toLowerCase() ?? "";
	const text = input.text?.toLowerCase().slice(0, 6000) ?? "";
	return /^(re|aw|fw|fwd|wg):/.test(subject.trim()) ||
		/\b(security|sicherheit|anmeldung|login|password|passwort|invoice|rechnung|receipt|quittung|beleg|belege|abrechnung|payment|zahlung|zahlungsbestätigung|bestelldaten|bestellung|bestellbestätigung|order confirmation)\b|message from|nachricht von|sent you a message|hat dir eine nachricht/.test(subject) ||
		Object.keys(input.headers ?? {}).some((key) => key.toLowerCase() === "in-reply-to") ||
		/\b(rechnungsnummer|belegnummer|bestellnummer|bestelldetails|invoice number|receipt number|order number|order confirmation|verification code|bestätigungscode|password reset|passwort zurücksetzen)\b/.test(text);
}

/** Narrow shortcuts spare AI calls without categorizing every message from a company's domain. */
export function resolveRoutineMail(input: RoutineInput): SortingDecision | null {
	if (isProtectedRoutineMail(input)) return null;
	const subject = input.subject?.toLowerCase() ?? "";
	const address = getEmailAddress(input.sender).trim().toLowerCase();
	// This specific automated sender also covers job titles that contain no "job alert" wording.
	if (address === "jobalerts-noreply@linkedin.com")
		return { category: "social", source: "rule", reason: "social_job_alert" };
	if (!isBulkMail(input)) return null;
	const text = input.text?.toLowerCase().slice(0, 6000) ?? "";
	if (
		(/\b(sale|discount|rabatt|gutschein|coupon|black friday|sonderaktion)\b|\d+\s*%/.test(subject) ||
			/\b(spare|sparen|save)\b.{0,30}(?:[€$£]|\beur\b|\busd\b)|(?:[€$£]\s*\d+|\d+\s*(?:€|eur))\b.{0,30}\b(rabatt|discount|off|sparen)\b/.test(subject)) &&
		/\b(buy|shop|kaufen|spar(?:e|en)|discount|rabatt|sale|bestellungen|orders|gutschein|coupon)\b/.test(text)
	)
		return { category: "promotions", source: "rule", reason: "marketing_list" };
	const domain = address.slice(address.lastIndexOf("@") + 1);
	if ((domain === "linkedin.com" || domain.endsWith(".linkedin.com")) &&
		/digest|profilbesuch|profile views|kontaktvorschl|suggestions|dein netzwerk|your network|weekly|wöchentlich/.test(subject))
		return { category: "social", source: "rule", reason: "social_digest" };
	return null;
}

export function resolveUnavailableSorting(input: RoutineInput, reason: string): SortingDecision {
	return isBulkMail(input) && !isProtectedRoutineMail(input)
		? { category: "promotions", source: "fallback", reason: "bulk_review", reviewRequired: true, fallbackReason: reason }
		: { category: "primary", source: "fallback", reason };
}
