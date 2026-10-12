import { getEmailAddress } from "@/lib/email/address";
import type { SortingDecision } from "./categories";

type RoutineInput = { sender: string; subject?: string | null; text?: string | null; headers?: Record<string, string> };

/** Require transaction wording, not a merchant domain or the mere presence of a price. */
export function resolveTransactionMail(input: RoutineInput): SortingDecision | null {
	const subject = input.subject?.normalize("NFKC").toLowerCase() ?? "";
	const text = input.text?.normalize("NFKC").toLowerCase().slice(0, 6000) ?? "";
	// Coupons, purchase invitations and invoice software newsletters are not actual transactions.
	if (/\b(rabatt|gutschein|coupon|discount|sale|angebot|angebote|offer|newsletter|black friday)\b|jetzt bestellen|order now/.test(subject)) return null;
	if (/\b(rechnung(?:en|snummer)?|abrechnung|quittung|beleg|zahlungsbeleg|zahlbeleg|zahlungsbestätigung|zahlungseingang|gutschrift|invoice|receipt|payment confirmation|payment received|credit note)\b/u.test(subject) &&
		!/rechnung(?:en)?\s+(?:erstellen|schreiben)|create invoices|invoicing software/.test(subject))
		return { category: "invoices", source: "rule", reason: "transaction_receipt" };
	if (/\b(bestell(?:ung|bestätigung|daten|details|nummer)|auftragsbestätigung|versandbestätigung|lieferbestätigung|lieferung|order confirmation|order number|shipping confirmation|shipment|delivery confirmation)\b/u.test(subject) &&
		!/erste bestellung|first order|free shipping|kostenlose lieferung/.test(subject))
		return { category: "orders", source: "rule", reason: "transaction_order" };
	// Body-only evidence needs both a specific transaction id and an amount/status.
	if (/\b(rechnungsnummer|belegnummer|invoice number|receipt number)\s*[:#]?\s*[\w-]*\d[\w-]*/iu.test(text) &&
		/\b(gesamtbetrag|rechnungsbetrag|total paid|amount paid|payment received)\b|(?:€|\$|£|\beur\b|\busd\b)\s*\d|\d[\d.,]*\s*(?:€|eur|usd)\b/iu.test(text))
		return { category: "invoices", source: "rule", reason: "transaction_receipt" };
	if (/\b(bestellnummer|order number)\s*[:#]?\s*[\w-]*\d[\w-]*/iu.test(text) &&
		/\b(bestellbestätigung|bestellung erhalten|order confirmed|order confirmation|shipped|versendet)\b/iu.test(text))
		return { category: "orders", source: "rule", reason: "transaction_order" };
	return null;
}

/** Account events include German compounds; a boundary after "Sicherheit" misses "Sicherheitswarnung". */
export function isAccountSecurityNotice(input: Pick<RoutineInput, "subject">): boolean {
	return /(?:^|[^\p{L}\p{N}])(?:sicherheits(?:warnung|meldung|benachrichtigung|hinweis)|anmelde(?:warnung|benachrichtigung)|(?:neue|ungewöhnliche|verdächtige)\s+anmeldung|(?:ungewöhnliche|verdächtige)\s+aktivität|passwort(?:änderung|änderungen)|passwort\s+(?:zurücksetzen|geändert)|security\s+(?:alert|warning|notice)|(?:new|unusual|suspicious)\s+(?:sign[ -]?in|login|activity)|password\s+(?:reset|changed|change))(?:$|[^\p{L}\p{N}])/iu.test(input.subject ?? "");
}

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
	return isAccountSecurityNotice(input) || /^(re|aw|fw|fwd|wg):/.test(subject.trim()) ||
		!!resolveTransactionMail(input) ||
		/\b(anmeldung|login)\b|message from|nachricht von|sent you a message|hat dir eine nachricht/.test(subject) ||
		Object.keys(input.headers ?? {}).some((key) => key.toLowerCase() === "in-reply-to") ||
		/\b(verification code|bestätigungscode|password reset|passwort zurücksetzen)\b/.test(text);
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
