import { buildSortingRequest, categoryCriteria, prepareSortingText, SORTING_MODEL, SORTING_MODEL_NAME } from "./decision-request";
export { categoryCriteria, SORTING_MODEL } from "./decision-request";
import { resolveRoutineMail, resolveTransactionMail, resolveUnavailableSorting, isProtectedRoutineMail, isAccountSecurityNotice, isOperationalSecurityNotice, isConsequentialNotice } from "./routine";
import { analyzeAuthentication } from "@/lib/spam/analyzers/authentication";
import { getSortingExamples } from "./learning";
import { CONTENT_POLICY_VERSION } from "./content-review";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
	contacts,
	mailboxSortingSettings,
	mailSortingOverrides,
} from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { isMailCategory } from "./categories";
import type { SortingDecision } from "./categories";
export const DEFAULT_SORTING_SETTINGS = {
	mode: "active" as const,
	dailyLimit: 1000,
	threshold: 0.8,
};

type ClefAnswer = {
	type?: string;
	choice?: string;
	probabilities?: Record<string, number>;
	noul?: number;
};
export function resolveClefDecision(
	answers: Record<string, ClefAnswer>,
	threshold: number,
	spamScore: number,
): SortingDecision {
	const category = answers.category;
	const fallback: SortingDecision = {
		category: "primary",
		source: "fallback",
		reason: "uncertain",
	};
	if (
		category?.type !== "choice" ||
		!category.probabilities ||
		![...Object.keys(categoryCriteria)].includes(category.choice ?? "")
	)
		return { ...fallback, reason: "invalid_model_response" };
	const values = Object.values(category.probabilities);
	if (
		![4, 6].includes(Object.keys(category.probabilities).length) ||
		Object.keys(category.probabilities).some(k => !Object.hasOwn(categoryCriteria, k)) ||
		["primary", "promotions", "social", "spam", ...(Object.keys(category.probabilities).length === 6 ? ["invoices", "orders"] : [])].some(
			(k) => typeof category.probabilities?.[k] !== "number",
		) ||
		values.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
		Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.03
	)
		return { ...fallback, reason: "invalid_model_response" };
	if (
		answers.action?.type !== "noul" ||
		answers.security?.type !== "noul" ||
		![answers.action.noul, answers.security.noul].every(
			(x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1,
		)
	)
		return { ...fallback, reason: "invalid_model_response" };
	// Saved four-category answers remain replayable; live requests include all six choices.
	const probabilities: Record<string, number> = { invoices: 0, orders: 0, ...category.probabilities };
	if (answers.inbox && (answers.inbox.type !== "noul" || typeof answers.inbox.noul !== "number" || !Number.isFinite(answers.inbox.noul) || answers.inbox.noul < 0 || answers.inbox.noul > 1))
		return { ...fallback, reason: "invalid_model_response" };
	// Old saved responses lack the inbox question; category.primary provides a replay-compatible fallback.
	const inboxProbability = answers.inbox?.noul ?? probabilities.primary;
	// Optional for replaying decisions saved before the marketing question existed.
	// Validate it before it can authorize any move; category probabilities alone
	// split their mass between advertising and spam for ordinary newsletters.
	const marketing = answers.marketing;
	if (marketing && (marketing.type !== "noul" || typeof marketing.noul !== "number" || !Number.isFinite(marketing.noul) || marketing.noul < 0 || marketing.noul > 1))
		return { ...fallback, reason: "invalid_model_response" };
	const result = {
		...fallback,
		probabilities,
		inboxProbability,
		personalProbability: answers.action.noul,
		securityProbability: answers.security.noul,
		...(marketing ? { marketingProbability: marketing.noul } : {}),
		suggestedCategory: category.choice,
	};
	if ((answers.action.noul ?? 1) >= 0.5 || (answers.security.noul ?? 1) >= 0.2)
		return { ...result, source: "clef", reason: "personal_or_security" };
	const transaction = probabilities.invoices >= probabilities.orders ? "invoices" : "orders";
	if (probabilities[transaction] >= threshold && probabilities[transaction] >= Math.max(probabilities.primary, probabilities.promotions, probabilities.social, probabilities.spam))
		return { ...result, category: transaction, source: "clef", reason: transaction };
	// Weak evidence of a receipt must never be converted to advertising as a side effect.
	if (probabilities.invoices + probabilities.orders > 0.2)
		return { ...result, source: "clef", reason: "transaction_uncertain", reviewRequired: true };
	// Excluding primary is insufficient: moving mail away also needs strong
	// evidence for its actual destination, especially advertising.
	// A mildly positive generic "inbox relevance" answer must not veto a clear
	// advertising classification when every concrete personal/security signal is low.
	// Strong inbox relevance, personal correspondence and financial uncertainty still win.
	const clearAdvertising = probabilities.promotions >= threshold && probabilities.primary <= 0.1 &&
		(answers.action.noul ?? 1) < 0.1 && (answers.security.noul ?? 1) < 0.1 && inboxProbability < 0.5;
	if ((inboxProbability > 1 - threshold + 1e-9 && !clearAdvertising) || probabilities.primary > 0.2)
		return { ...result, source: "clef", reason: "inbox_uncertain" };
	if (probabilities.spam >= threshold && spamScore >= 40)
		return { ...result, source: "clef", reason: "spam_correlated", spam: true };
	// A positive marketing answer supplies actual advertising evidence. Neither
	// a low inbox score nor an uncorrelated spam guess is enough on its own.
	// All personal, security, transaction and primary-inbox safeguards above apply.
	const marketingThreshold = probabilities.promotions >= 0.5 && probabilities.promotions > Math.max(probabilities.social, probabilities.spam)
		? threshold : Math.max(0.9, threshold);
	if ((marketing?.noul ?? 0) >= marketingThreshold && probabilities.social < threshold)
		return { ...result, category: "promotions", suggestedCategory: "promotions", source: "clef", reason: "marketing_confirmed" };
	if (probabilities.spam >= Math.max(probabilities.promotions, probabilities.social))
		return { ...result, source: "clef", reason: "spam_uncertain", reviewRequired: true };
	const destination = probabilities.social > probabilities.promotions ? "social" : "promotions";
	// Respect the mailbox's configured confidence instead of silently forcing 90%.
	if (probabilities[destination] < threshold)
		return { ...result, source: "clef", reason: "category_uncertain", reviewRequired: true };
	return { ...result, category: destination, source: "clef", reason: destination };

}
export function applySortingMode(decision: SortingDecision, mode: "active" | "observe" | "off"): SortingDecision {
	return {
		...decision,
		policyVersion: CONTENT_POLICY_VERSION,
		...(mode === "observe" ? {
			suggestedCategory: decision.spam ? "spam" : decision.suggestedCategory ?? decision.category,
			category: "primary" as const,
			spam: false,
			reason: "observation",
		} : {}),
	};
}

export async function classifyIncomingMail(
	env: CloudflareEnv,
	input: {
		mailboxId: string;
		userId: string;
		sender: string;
		recipient: string;
		subject?: string | null;
		text?: string | null;
		spamScore: number;
		headers?: Record<string, string>;
		/** Background archive sorting leaves part of the shared daily quota for new mail. */
		aiBudgetCeiling?: number;
		/** Historical review must leave uncertain/unavailable mail in its existing category. */
		conservativeReview?: boolean;
	},
): Promise<SortingDecision> {
	const fallback: SortingDecision = {
		category: "primary",
		source: "fallback",
		reason: "unavailable",
	};
	let mode: "active" | "observe" | "off" | undefined;
	try {
		input = { ...input, text: prepareSortingText(input.text) };
		const db = getDb(env);
		const sender = getEmailAddress(input.sender).trim().toLowerCase();
		const [settings] = await db
			.select()
			.from(mailboxSortingSettings)
			.where(eq(mailboxSortingSettings.mailboxId, input.mailboxId))
			.limit(1);
		const config = settings ?? DEFAULT_SORTING_SETTINGS;
		mode = config.mode;
		const finalize = (decision: SortingDecision) => applySortingMode(decision, config.mode);
		const unavailable = (reason: string) => input.conservativeReview
			? { ...fallback, reason } : resolveUnavailableSorting(input, reason);
		if (config.mode === "off") return finalize({ ...fallback, reason: "disabled" });
		const securityNotice = isAccountSecurityNotice(input) || isOperationalSecurityNotice(input);
		const consequentialNotice = isConsequentialNotice(input);
		// Read only authentication results from Cloudflare's receiver, never trust a From name.
		const authentication = analyzeAuthentication(input.headers).map((signal) => signal.id);
		const failedProtectedAuthentication = (securityNotice || consequentialNotice) && authentication.some((id) => id.endsWith("_failed"));
		const [override] = await db
			.select()
			.from(mailSortingOverrides)
			.where(
				and(
					eq(mailSortingOverrides.mailboxId, input.mailboxId),
					eq(mailSortingOverrides.sender, sender),
				),
			)
			.limit(1);
		if (override && isMailCategory(override.category) &&
			(override.category === "primary" || !isProtectedRoutineMail(input)))
			return finalize({ category: override.category, suggestedCategory: override.category, source: "override", reason: "sender_override" });
		if (input.conservativeReview && !securityNotice &&
			(/^(?:re|aw)\s*:/i.test(input.subject?.trim() ?? "") || Object.keys(input.headers ?? {}).some(key => key.toLowerCase() === "in-reply-to")))
			return finalize({ ...fallback, reason: "conversation_review", reviewRequired: true });
		if (consequentialNotice && input.spamScore < 40 && !authentication.some(id => id.endsWith("_failed")))
			return finalize({ category: "primary", source: "rule", reason: "protected_legal_or_payment_demand" });
		const transaction = resolveTransactionMail(input);
		if (!securityNotice && transaction && input.spamScore < 40 && !authentication.some(id => id.endsWith("_failed")))
			return finalize(transaction);
		if (isProtectedRoutineMail(input) && input.spamScore < 40 && !failedProtectedAuthentication)
			return finalize({ category: "primary", source: "rule", reason: securityNotice ? "protected_account_security" : "protected_transaction_or_conversation" });
		const routine = resolveRoutineMail(input);
		if (routine) return finalize(routine);
		if (!env.AI) return finalize(unavailable("unavailable"));
		const day = new Date().toISOString().slice(0, 10);
		const dailyLimit = Math.min(config.dailyLimit, input.aiBudgetCeiling ?? config.dailyLimit);
		const reservation = await env.DB.prepare(
			"INSERT INTO mail_sorting_usage(mailbox_id,day,requests,input_tokens) SELECT ?,?,1,0 WHERE ?>0 ON CONFLICT(mailbox_id,day) DO UPDATE SET requests=requests+1 WHERE requests<? RETURNING requests",
		)
			.bind(input.mailboxId, day, dailyLimit, dailyLimit)
			.first();
		if (!reservation) return finalize(unavailable("daily_limit"));
		const [contact] = await db
			.select({ source: contacts.source })
			.from(contacts)
			.where(and(eq(contacts.userId, input.userId), eq(contacts.email, sender)))
			.limit(1);
		const corrections = await getSortingExamples(env, input.mailboxId, { sender, subject: input.subject });
		const request = buildSortingRequest({
			sender,
			authentication,
			spamScore: input.spamScore,
			userCorrections: corrections,
			recipient: input.recipient.slice(0, 300),
			subject: input.subject?.slice(0, 400),
			visibleText: input.text?.slice(0, 6000),
			relationship: contact?.source ?? "unknown",
			listMail: Object.keys(input.headers ?? {}).some(
				(k) => k.toLowerCase() === "list-unsubscribe",
			),
			});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const ai = env.AI as unknown as {
				run: (
					model: string,
					input: unknown,
				) => Promise<{
					model?: string;
					answers: Record<string, ClefAnswer>;
					usage?: { input_tokens?: number };
				}>;
			};
			const result = await Promise.race([
				ai.run(SORTING_MODEL, request),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("classification_timeout")),
						8000,
					);
				}),
			]);
			if (
				result.usage?.input_tokens &&
				Number.isSafeInteger(result.usage.input_tokens)
			)
				await env.DB.prepare(
					"UPDATE mail_sorting_usage SET input_tokens=input_tokens+? WHERE mailbox_id=? AND day=?",
				)
					.bind(result.usage.input_tokens, input.mailboxId, day)
					.run();
			const decision = resolveClefDecision(
				result.model && result.model !== SORTING_MODEL_NAME && result.model !== SORTING_MODEL ? {} : result.answers ?? {},
				config.threshold,
				input.spamScore,
			);
			return finalize({
				...(decision.reason === "invalid_model_response" ? unavailable(decision.reason) : decision),
				learningExamples: corrections.length,
				model: SORTING_MODEL,
			});
		} finally {
			if (timer) clearTimeout(timer);
		}
	} catch {
		return mode && mode !== "off"
			? applySortingMode(input.conservativeReview ? { ...fallback, reason: "ai_error" } : resolveUnavailableSorting(input, "ai_error"), mode)
			: { ...fallback, reason: "ai_error" };
	}
}
