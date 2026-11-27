import type { TranslationKey } from "@/lib/i18n/types";
import type { TranslationVars } from "@/lib/i18n/utils";

export type ComposeSendErrorContext = {
	status?: number;
	rayId?: string | null;
	/** The request failed without an answer (offline, connection dropped, timed out). */
	network?: boolean;
	/** What the failure said, when it was not a plain lost connection. */
	detail?: string | null;
};

function firstValidationError(error: unknown): string | null {
	if (!error || typeof error !== "object") return null;
	const { formErrors, fieldErrors } = error as { formErrors?: unknown; fieldErrors?: unknown };
	if (Array.isArray(formErrors)) {
		const message = formErrors.find((item): item is string => typeof item === "string" && item.trim().length > 0);
		if (message) return message.trim();
	}
	if (fieldErrors && typeof fieldErrors === "object") {
		for (const value of Object.values(fieldErrors as Record<string, unknown>)) {
			if (!Array.isArray(value)) continue;
			const message = value.find((item): item is string => typeof item === "string" && item.trim().length > 0);
			if (message) return message.trim();
		}
	}
	return null;
}

function formatFallbackSendError(base: string, context?: ComposeSendErrorContext): string {
	const details: string[] = [];
	if (typeof context?.status === "number" && Number.isInteger(context.status) && context.status >= 400) {
		details.push(`HTTP ${context.status}`);
	}
	const ray = context?.rayId?.trim().split("-")[0] ?? "";
	if (details.length > 0 && /^[a-z0-9]{8,32}$/i.test(ray)) {
		details.push(`Ray ${ray}`);
	}
	return details.length > 0 ? `${base} (${details.join(", ")})` : base;
}

/**
 * What to do after a failed send. An answer of 500 and above, a gateway in front of the server or a
 * lost connection can all happen after the message was accepted: sending again could deliver it
 * twice, so the writer is sent to look first. A refusal (4xx) changed nothing; trying again is safe.
 */
function nextStep(t: (key: TranslationKey) => string, context?: ComposeSendErrorContext): string | null {
	if (context?.network || (context?.status !== undefined && context.status >= 500)) return t("compose.error.sendCheckFirst");
	return context?.status !== undefined ? t("compose.error.sendRetry") : null;
}

function withNextStep(message: string, t: (key: TranslationKey) => string, context?: ComposeSendErrorContext): string {
	const step = nextStep(t, context);
	return step ? `${message}. ${step}` : message;
}

/** The server's fixed refusals, said in the interface language. Null for anything else. */
function knownRefusal(error: string): TranslationKey | null {
	if (error === "Mailbox not found" || error === "Sender account not found" || error === "You do not have permission to send from this mailbox" || error === "Sender address does not match the selected mailbox" || error === "Mailbox is required") return "compose.error.sendNotAllowed";
	if (error === "Request body is too large" || error.startsWith("Attachments exceed") || error.startsWith("Message exceeds") || error.startsWith("A message can include at most") || error.includes("attachment limit")) return "compose.error.sendTooLarge";
	if (error === "At least one recipient is required") return "compose.error.noRecipient";
	return null;
}

export function composeSendError(
	data: unknown,
	t: (key: TranslationKey, vars?: TranslationVars) => string,
	context?: ComposeSendErrorContext,
): string {
	// A connection that broke says nothing about whether the message arrived.
	if (context?.network) return withNextStep(`${t("compose.error.sendFailed")} (${context.detail?.trim() || t("compose.error.sendNoConnection")})`, t, context);
	const fallback = formatFallbackSendError(t("compose.error.sendFailed"), context);
	// The answers the writer can act on are said in the interface language, whoever worded them.
	if (context?.status === 413) return t("compose.error.sendTooLarge");
	if (context?.status === 401) return t("compose.error.sendSignedOut");
	if (!data || typeof data !== "object") return withNextStep(fallback, t, context);
	const result = data as { code?: unknown; filename?: unknown; error?: unknown };
	if (result.code === "attachment_unavailable" && typeof result.filename === "string") {
		return t("compose.error.attachmentUnavailable", { filename: result.filename });
	}
	if (result.code === "draft_changed" || result.code === "draft_locked") return t("compose.error.draftChanged");
	if (result.code === "delivery_unknown") return t("compose.error.deliveryUnknown");
	if (result.code === "delivery_status_pending") return t("compose.error.deliveryStatusPending");
	// Validation errors may be structured objects; never hand them to React as text.
	const validation = context?.status !== undefined ? firstValidationError(result.error) : null;
	const said = typeof result.error === "string" && result.error.trim() ? result.error.trim() : validation;
	if (said) {
		const known = knownRefusal(said);
		if (known) return t(known);
		// Without a status the caller only has the server's words; with one they are a detail of ours.
		return context?.status === undefined ? said : withNextStep(`${t("compose.error.sendFailed")}: ${said.replace(/[.!]+$/, "")}`, t, context);
	}
	return withNextStep(fallback, t, context);
}
