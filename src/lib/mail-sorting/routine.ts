import { getEmailAddress } from "@/lib/email/address";
import type { SortingDecision } from "./categories";

type RoutineInput = { sender: string; subject?: string | null; text?: string | null; headers?: Record<string, string> };

/** Personal legal/collection matters need attention, even in automated acknowledgements. */
export function isConsequentialNotice(input: RoutineInput): boolean {
	const subject = input.subject?.normalize("NFKC").toLowerCase() ?? "";
	const text = input.text?.normalize("NFKC").toLowerCase().slice(0, 6000) ?? "";
	// Educational/marketing content about debt collection is not a personal claim.
	if (/\b(?:newsletter|webinar|seminar|ratgeber|inkassosoftware|invoicing software)\b|tipps (?:für|zum|zur)|software für/.test(subject)) return false;
	const legal = /\b(?:inkasso|inkassoverfahren|forderung(?:en|sangelegenheit)?|widerspruch|identitätsmissbrauch|zahlungsaufforderung|mahnung|mahnbescheid|vollstreckung|fristsetzung|debt collection|payment demand|legal notice|notice of default)\b/u;
	const reference = /\b(?:aktenzeichen|geschäftszeichen|vorgangsnummer|case (?:number|reference)|reference number)\s*[:#-]?\s*[\w/-]*\d[\w/-]*/iu;
	if (legal.test(subject) && reference.test(subject + " " + text)) return true;
	if (/\b(?:zahlungsaufforderung|mahnbescheid|vollstreckungsbescheid|letzte mahnung|letzte zahlungserinnerung|fristsetzung|payment demand|notice of default)\b/u.test(subject)) return true;
	// Generic subjects require a case reference plus a concrete claim/request in the body.
	return legal.test(text) && reference.test(text) &&
		/\b(?:offene forderung|gegenständliche forderung|zahlen sie|überweisen sie|bitte.{0,25}(?:antworten|melden|zahlen)|frist|ihren widerspruch|ihre letzte mitteilung|outstanding (?:debt|balance)|please (?:pay|respond)|payment due)\b/u.test(text);
}

/** Require transaction wording, not a merchant domain or the mere presence of a price. */
export function resolveTransactionMail(input: RoutineInput): SortingDecision | null {
	const subject = input.subject?.normalize("NFKC").toLowerCase() ?? "";
	const text = input.text?.normalize("NFKC").toLowerCase().slice(0, 6000) ?? "";
	// Coupons, purchase invitations and invoice software newsletters are not actual transactions.
	if (/\b(rabatt|gutschein|coupon|discount|sale|angebot|angebote|offer|black friday)\b|jetzt bestellen|order now/.test(subject)) return null;
	if (/\bnewsletter\b/.test(subject) && !/^(?:ihre|deine|your)\s+(?:rechnung|quittung|invoice|receipt)\b/.test(subject)) return null;
	// Reminders for an agreed payment are financial mail, even without the word Rechnung.
	// Require a concrete debit/payment event; "flexible installments" in an advert is insufficient.
	if (/\b(?:ihre|deine|your)\s+(?:nächste\s+)?(?:ratenzahlung(?:-rate)?|rate|installment|instalment)\b.{0,70}\b(?:abgebucht|fällig|due|debited)\b/u.test(subject) ||
		/\b(?:zahlungserinnerung|mahnung|payment reminder|payment scheduled|scheduled payment|aktualisierte zahlungsinformation(?:en)?|zahlungsinformation für (?:deine|ihre) bestellung)\b/u.test(subject) &&
		/\b(?:rechnungsnummer|rechnung|invoice|zahlung|payment|abgebucht|fällig)\b/u.test(text) && /\d[\d.,]*\s*(?:€|eur|usd)|(?:€|\$|£)\s*\d/iu.test(text))
		return { category: "invoices", source: "rule", reason: "transaction_payment_notice" };
	if (/\b(rechnung(?:en|snummer)?|abrechnung|quittung|beleg|zahlungsbeleg|zahlbeleg|zahlungsbestätigung|zahlungseingang|gutschrift|invoice|receipt|payment confirmation|payment received|credit note)\b/u.test(subject) &&
		!/rechnung(?:en)?\s+(?:erstellen|schreiben)|create invoices|invoicing software/.test(subject))
		return { category: "invoices", source: "rule", reason: "transaction_receipt" };
	if (/\b(bestell(?:ung|bestätigung|daten|details|nummer)|auftragsbestätigung|versandbestätigung|lieferbestätigung|lieferung|order confirmation|order number|shipping confirmation|shipment|delivery confirmation)\b/u.test(subject) &&
		!/erste bestellung|first order|free shipping|kostenlose lieferung/.test(subject))
		return { category: "orders", source: "rule", reason: "transaction_order" };
	if (/^(?:bestellt|versendet|geliefert|zugestellt|in zustellung)\s*:/u.test(subject) &&
		/\b(?:bestellnr\.?|bestellnummer|order number)\s*[:#]?\s*[\w-]*\d[\w-]*/iu.test(text))
		return { category: "orders", source: "rule", reason: "transaction_order_status" };
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
	return /(?:^|[^\p{L}\p{N}])(?:sicherheits(?:warnung|meldung|benachrichtigung|hinweis)|anmelde(?:warnung|benachrichtigung)|(?:neue|ungewöhnliche|verdächtige)\s+anmeldung|(?:ungewöhnliche|verdächtige)\s+aktivität|passwort(?:änderung|änderungen)|(?:passwort|kennwort)(?:\/benutzername)?\s+(?:(?:wurde|wird)\s+)?(?:zurücksetzen|geändert)|neues gerät für (?:ihr|dein) konto|security\s+(?:alert|warning|notice)|(?:new|unusual|suspicious)\s+(?:sign[ -]?in|login|activity)|password\s+(?:reset|changed|change)|recover your.{0,30}account)(?:$|[^\p{L}\p{N}])/iu.test(input.subject ?? "");
}

export function isBulkMail(input: Pick<RoutineInput, "headers">): boolean {
	return Object.entries(input.headers ?? {}).some(([key, value]) =>
		key.toLowerCase() === "list-unsubscribe" || key.toLowerCase() === "list-id" ||
		(key.toLowerCase() === "precedence" && /^(bulk|list)$/i.test(value.trim())),
	);
}

/** Vulnerability bulletins remain actionable even when sent as a mailing list. */
export function isOperationalSecurityNotice(input: RoutineInput): boolean {
	return /security (?:update|advisory|advisories|bulletin)|sicherheits(?:update|lücke|lücken)/i.test(input.subject ?? "") &&
		/\b(?:CVE-\d{4}-\d+|GHSA-[a-z\d-]+)|severity:\s*(?:high|critical)|kritische sicherheitslücke/i.test(input.text?.slice(0, 6000) ?? "");
}

/** An explanation mentioning codes is not itself a delivered authentication code. */
function containsAuthenticationRequest(input: RoutineInput): boolean {
	const subject = input.subject ?? "";
	const text = input.text?.slice(0, 6000) ?? "";
	const code = "(?:verification code|confirmation code|bestätigungscode|sicherheitscode|einmalcode|one-time code)";
	return new RegExp(`\\b(?:your|dein(?:en|er)?|ihr(?:en|er)?)\\s+(?:[a-z0-9-]+\\s+){0,2}${code}\\b`, "i").test(subject) ||
		new RegExp(`\\b${code}\\s*(?:(?:is|ist|lautet)\\s*)?[:–-]?\\s*(?:[0-9][ -]?){4,8}\\b`, "i").test(text) ||
		/\b(?:you requested|sie haben|du hast).{0,60}(?:password reset|passwort.{0,20}zurückzusetzen)/i.test(text);
}

/** Never quarantine a conversation, security alert or transaction merely because it has list headers. */
export function isProtectedRoutineMail(input: RoutineInput): boolean {
	const subject = input.subject?.toLowerCase() ?? "";
	return isConsequentialNotice(input) || isAccountSecurityNotice(input) || isOperationalSecurityNotice(input) || /^(re|aw|fw|fwd|wg):/.test(subject.trim()) ||
		!!resolveTransactionMail(input) ||
		/(?:bestätigung|confirmation).{0,55}(?:kündigung|widerruf|cancellation|termination)|(?:kündigung|widerruf|cancellation).{0,55}(?:bestätigt|confirmed)/i.test(subject) ||
		/\b(anmeldung|login)\b|message from|nachricht von|sent you a message|hat dir eine nachricht/.test(subject) ||
		Object.keys(input.headers ?? {}).some((key) => key.toLowerCase() === "in-reply-to") ||
		containsAuthenticationRequest(input);
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
	// Public forum excerpts may use first person without being a message to the
	// recipient. Require both a digest heading and a list delivery signal.
	if (/aktuell im forum|forum digest|community digest|neues aus (?:dem|deinem) forum/i.test(subject) &&
		/beiträge|diskussionen|mehr lesen|recent posts|discussions|read more/i.test(text))
		return { category: "social", source: "rule", reason: "social_forum_digest" };
	// Explicit editorial formats require mailing-list delivery and content evidence.
	// An unsubscribe footer alone cannot override an account or personal notice.
	const editorial = /\b(?:newsletter|workout of the day|daily briefing|weekly roundup)\b/i.test(subject) ||
		/der newsletter für|staff writer,? newsletters|let['’]s get into the headlines|in (?:diesem|unserem|this|our) newsletter/i.test(text.slice(0, 1800));
	// Long editions can place their footer beyond the bounded content window.
	// A clear editorial signature plus the list header is sufficient evidence.
	const editorialSignature = /staff writer,?\s*newsletters|let['’]s get into the headlines/i.test(text.slice(0, 1800));
	if (editorial && (editorialSignature || /unsubscribe|abbestellen|abmelden|e-mail-einstellungen|email preferences/i.test(text)))
		return { category: "promotions", source: "rule", reason: "editorial_newsletter" };
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

export function resolveUnavailableSorting(_input: RoutineInput, reason: string): SortingDecision {
	return { category: "primary", source: "fallback", reason, reviewRequired: true, fallbackReason: reason };
}
