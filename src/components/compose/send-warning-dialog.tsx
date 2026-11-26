"use client";

import { AlertTriangle } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { SendWarning } from "./send-warnings-types";

/**
 * Asks before a message goes when something about it looks like a mistake.
 * Enter never sends from here: the dialog opens with the way back focused.
 */
export function SendWarningDialog({ warnings, onCancel, onSendAnyway, onMoveToBcc }: {
	warnings: SendWarning[] | null;
	onCancel: () => void;
	onSendAnyway: () => void;
	/** Offered when outsiders would see each other; moves them to Bcc and sends. */
	onMoveToBcc?: () => void;
}) {
	const { t } = useLanguage();
	const lines = (warnings ?? []).map((warning) => {
		if (warning.kind === "lookalike") return t("compose.warn.lookalike", { address: warning.address, like: warning.like });
		if (warning.kind === "outsiders") return t("compose.warn.outsiders", { people: warning.count, domains: warning.domains });
		if (warning.kind === "tooManyRecipients") return t("compose.warn.tooManyRecipients", { checked: warning.checked });
		return t("compose.warn.missingAttachment");
	});
	const offersBcc = !!onMoveToBcc && !!warnings?.some((warning) => warning.kind === "outsiders");
	return (
		<Dialog open={!!warnings?.length} onOpenChange={(open) => { if (!open) onCancel(); }}>
			<DialogContent
				data-compose-layer
				data-send-warning
				showCloseButton={false}
				className="max-h-[calc(100vh-4rem)] overflow-y-auto"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					(event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-send-warning-back]")?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2"><AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0 text-amber-700" />{t("compose.warn.title")}</DialogTitle>
					<DialogDescription>{t("compose.warn.intro")}</DialogDescription>
				</DialogHeader>
				<ul className="space-y-2 text-sm text-neutral-800">
					{lines.map((line, index) => <li key={index} className="break-words rounded-lg bg-neutral-50 px-3 py-2">{line}</li>)}
				</ul>
				<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<Button type="button" variant="outline" data-send-warning-back onClick={onCancel}>{t("compose.warn.back")}</Button>
					{offersBcc && <Button type="button" variant="outline" onClick={onMoveToBcc}>{t("compose.warn.moveToBcc")}</Button>}
					<Button type="button" onClick={onSendAnyway}>{t("compose.warn.sendAnyway")}</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
