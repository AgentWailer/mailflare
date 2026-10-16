"use client";

import { useId } from "react";
import { useLanguage } from "@/components/language-provider";
import { useMessageDensity } from "@/components/messages/use-message-density";

export function MessageDensitySettings({ className = "" }: { className?: string }) {
	const { t } = useLanguage();
	const [density, setDensity] = useMessageDensity();
	const name = useId();
	return <fieldset className={`min-w-0 ${className}`}>
		<legend className="mb-2 text-sm font-medium text-neutral-800">{t("settings.density.title")}</legend>
		<div className="grid gap-2">
			{(["comfortable", "compact"] as const).map(value => <label key={value} className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${density === value ? "border-blue-500 bg-blue-50" : "border-neutral-200 hover:bg-neutral-50"}`}>
				<input type="radio" name={name} value={value} checked={density === value} onChange={() => setDensity(value)} className="h-4 w-4 shrink-0 accent-blue-600" />
				<span className="min-w-0 flex-1"><span className="block text-sm font-medium text-neutral-900">{t(value === "compact" ? "settings.density.compact" : "settings.density.comfortable")}</span><span className="block text-xs text-neutral-600">{t(value === "compact" ? "settings.density.compactDescription" : "settings.density.comfortableDescription")}</span></span>
				<span aria-hidden="true" className={`flex h-10 w-16 shrink-0 flex-col justify-center rounded border border-neutral-200 bg-white px-2 ${value === "compact" ? "gap-1" : "gap-2"}`}>{Array.from({ length: value === "compact" ? 4 : 3 }, (_, index) => <span key={index} className="h-0.5 rounded bg-neutral-300" />)}</span>
			</label>)}
		</div>
	</fieldset>;
}
