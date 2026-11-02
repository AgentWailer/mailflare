import type { TranslationKey } from "@/lib/i18n/types";
import type { TranslationVars } from "@/lib/i18n/utils";

export function composeSendError(data: unknown, t: (key: TranslationKey, vars?: TranslationVars) => string): string {
	if (!data || typeof data !== "object") return t("compose.error.sendFailed");
	const result = data as { code?: unknown; filename?: unknown; error?: unknown };
	if (result.code === "attachment_unavailable" && typeof result.filename === "string") {
		return t("compose.error.attachmentUnavailable", { filename: result.filename });
	}
	if (result.code === "draft_changed" || result.code === "draft_locked") return t("compose.error.draftChanged");
	if (result.code === "delivery_unknown") return t("compose.error.deliveryUnknown");
	if (result.code === "delivery_status_pending") return t("compose.error.deliveryStatusPending");
	// Validation errors may be structured objects; never hand them to React as text.
	return typeof result.error === "string" ? result.error : t("compose.error.sendFailed");
}
