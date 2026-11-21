import type { TranslationKey } from "@/lib/i18n/types";
import type { TranslationVars } from "@/lib/i18n/utils";

export type ComposeSendErrorContext = {
	status?: number;
	rayId?: string | null;
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

export function composeSendError(
	data: unknown,
	t: (key: TranslationKey, vars?: TranslationVars) => string,
	context?: ComposeSendErrorContext,
): string {
	const fallback = formatFallbackSendError(t("compose.error.sendFailed"), context);
	if (!data || typeof data !== "object") return fallback;
	const result = data as { code?: unknown; filename?: unknown; error?: unknown };
	if (result.code === "attachment_unavailable" && typeof result.filename === "string") {
		return t("compose.error.attachmentUnavailable", { filename: result.filename });
	}
	if (result.code === "draft_changed" || result.code === "draft_locked") return t("compose.error.draftChanged");
	if (result.code === "delivery_unknown") return t("compose.error.deliveryUnknown");
	if (result.code === "delivery_status_pending") return t("compose.error.deliveryStatusPending");
	// Validation errors may be structured objects; never hand them to React as text.
	if (typeof result.error === "string" && result.error.trim()) return result.error;
	if (context?.status !== undefined) {
		const validation = firstValidationError(result.error);
		if (validation) return `${t("compose.error.sendFailed")}: ${validation}`;
	}
	return fallback;
}
