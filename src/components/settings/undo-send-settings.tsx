"use client";

import { useId } from "react";
import { useLanguage } from "@/components/language-provider";
import { UNDO_SEND_OPTIONS, useUndoSendSeconds } from "@/components/compose/use-undo-send";

export function UndoSendSettings() {
	const { t } = useLanguage();
	const [seconds, setSeconds] = useUndoSendSeconds();
	const name = useId();
	return <fieldset className="min-w-0 space-y-3">
		<legend className="sr-only">{t("settings.undoSend.title")}</legend>
		<p className="text-sm text-neutral-500">{t("settings.undoSend.description")}</p>
		<div className="grid gap-2 sm:grid-cols-2">
			{UNDO_SEND_OPTIONS.map(value => <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${seconds === value ? "border-blue-500 bg-blue-50" : "border-neutral-200 hover:bg-neutral-50"}`}>
				<input type="radio" name={name} value={value} checked={seconds === value} onChange={() => setSeconds(value)} className="h-4 w-4 shrink-0 accent-blue-600" />
				<span className="text-sm font-medium text-neutral-900">{value === 0 ? t("settings.undoSend.off") : t("settings.undoSend.seconds", { seconds: value })}</span>
			</label>)}
		</div>
		<p className="text-sm text-neutral-500">{t("settings.undoSend.note")}</p>
	</fieldset>;
}
