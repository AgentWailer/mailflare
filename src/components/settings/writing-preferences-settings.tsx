"use client";

import { useEffect, useId, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { DEFAULT_WRITING_PREFERENCES, writingPreferencesSchema } from "@/lib/agent/writing-preferences";
import type { WritingPreferences } from "@/lib/agent/writing-preferences";
import type { AgentModelRates } from "@/lib/agent/provider-types";
import { CLOUDFLARE_WRITING_MODEL } from "@/lib/agent/provider-constants";
import type { TranslationKey } from "@/lib/i18n/types";

const tones: Array<{ value: WritingPreferences["tone"]; label: TranslationKey }> = [
	{ value: "keep", label: "writing.tone.keep" },
	{ value: "professional", label: "writing.tone.professional" },
	{ value: "friendly", label: "writing.tone.friendly" },
	{ value: "direct", label: "writing.tone.direct" },
	{ value: "formal", label: "writing.tone.formal" },
];
const styles: Array<{ value: WritingPreferences["style"]; label: TranslationKey }> = [
	{ value: "polish", label: "writing.style.polish" },
	{ value: "correct", label: "writing.style.correct" },
	{ value: "shorter", label: "writing.style.shorter" },
	{ value: "longer", label: "writing.style.longer" },
];
const fieldClass = "min-h-11 w-full rounded-xl border border-neutral-300 bg-white px-3 text-base text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
type ModelOption = { id: string; rates?: AgentModelRates };
const modelNames: Record<string, string> = {
	[CLOUDFLARE_WRITING_MODEL]: "Gemma 4 26B A4B IT",
	"@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small 3.1",
	"@cf/openai/gpt-oss-120b": "GPT-OSS 120B",
	"moonshotai/kimi-k3": "Kimi K3",
};
const modelName = (id: string) => modelNames[id] ?? id;

export function WritingPreferencesSettings() {
	const { t, locale } = useLanguage();
	const id = useId();
	const [preferences, setPreferences] = useState<WritingPreferences>(DEFAULT_WRITING_PREFERENCES);
	const [original, setOriginal] = useState<WritingPreferences | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(false);
	const [saved, setSaved] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const selectedModel = preferences.modelId ?? defaultModel;
	const rates = models.find(model => model.id === selectedModel)?.rates;

	useEffect(() => {
		const controller = new AbortController();
		void authFetch("/api/settings/writing", { signal: controller.signal }).then(async response => {
			if (!response.ok) throw new Error("Load failed");
			const data = await response.json() as { preferences?: unknown; models?: ModelOption[]; defaultModel?: string };
			const parsed = writingPreferencesSchema.safeParse(data.preferences);
			if (!parsed.success) throw new Error("Invalid preferences");
			if (!controller.signal.aborted) { setPreferences(parsed.data); setOriginal(parsed.data); setModels(data.models ?? []); setDefaultModel(data.defaultModel ?? ""); }
		}).catch(() => { if (!controller.signal.aborted) setError(true); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [attempt]);

	function change(next: WritingPreferences) { setPreferences(next); setSaved(false); setError(false); }
	async function save() {
		if (saving || !original) return;
		setSaving(true); setSaved(false); setError(false);
		try {
			const response = await authFetch("/api/settings/writing", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) });
			if (!response.ok) throw new Error("Save failed");
			const parsed = writingPreferencesSchema.parse((await response.json() as { preferences: unknown }).preferences);
			setPreferences(parsed); setOriginal(parsed); setSaved(true);
		} catch { setError(true); }
		finally { setSaving(false); }
	}

	return <div data-writing-preferences className="space-y-4">
		<p id={`${id}-help`} className="text-sm leading-6 text-neutral-600">{t("writing.description")}</p>
		{loading ? <p role="status" className="text-sm text-neutral-500">{t("writing.loading")}</p> : original && <>
			<div className="space-y-2">
				<label className="block space-y-2 text-sm font-medium"><span>{t("writing.model")}</span><select data-writing-model aria-label={t("writing.model")} aria-describedby={`${id}-model-help`} value={preferences.modelId ?? ""} disabled={saving || !models.length} onChange={event => change({ ...preferences, modelId: event.target.value || null })} className={fieldClass}>
					<option value="">{t("writing.model.default")}{defaultModel ? `: ${modelName(defaultModel)}` : ""}</option>
					{models.map(model => <option key={model.id} value={model.id}>{modelName(model.id)}</option>)}
				</select></label>
				<div id={`${id}-model-help`} className="space-y-1 text-xs leading-5 text-neutral-500">
					<p>{t("writing.model.help")}</p>
					{rates?.input != null && rates.output != null ? <p>{t("writing.model.price", { input: rates.input.toLocaleString(locale), output: rates.output.toLocaleString(locale) })}</p> : <p>{t("writing.model.noPrice")}</p>}
					{selectedModel === CLOUDFLARE_WRITING_MODEL && <p>{t("writing.model.gemmaFast")}</p>}
				</div>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<label className="space-y-2 text-sm font-medium"><span>{t("writing.tone")}</span><select aria-label={t("writing.tone")} value={preferences.tone} disabled={saving} onChange={event => change({ ...preferences, tone: event.target.value as WritingPreferences["tone"] })} className={fieldClass}>{tones.map(tone => <option key={tone.value} value={tone.value}>{t(tone.label)}</option>)}</select></label>
				<label className="space-y-2 text-sm font-medium"><span>{t("writing.style")}</span><select aria-label={t("writing.style")} value={preferences.style} disabled={saving} onChange={event => change({ ...preferences, style: event.target.value as WritingPreferences["style"] })} className={fieldClass}>{styles.map(style => <option key={style.value} value={style.value}>{t(style.label)}</option>)}</select></label>
			</div>
			<label className="block space-y-2 text-sm font-medium"><span>{t("writing.instructions")}</span><textarea aria-describedby={`${id}-help ${id}-count`} aria-label={t("writing.instructions")} rows={4} maxLength={2000} value={preferences.instructions} disabled={saving} onChange={event => change({ ...preferences, instructions: event.target.value })} placeholder={t("writing.placeholder")} className={`${fieldClass} resize-y py-3 font-normal`} /></label>
			<p id={`${id}-count`} className="text-right text-xs text-neutral-500">{preferences.instructions.length} / 2000</p>
			<div className="flex flex-wrap items-center gap-3"><button type="button" disabled={saving || JSON.stringify(preferences) === JSON.stringify(original)} onClick={() => void save()} className="min-h-11 rounded-full bg-blue-600 px-5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{t(saving ? "writing.saving" : "writing.save")}</button><button type="button" disabled={saving} onClick={() => change({ ...DEFAULT_WRITING_PREFERENCES })} className="min-h-11 rounded-full px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100">{t("writing.reset")}</button>{saved && <span role="status" className="text-sm text-green-700">{t("writing.saved")}</span>}</div>
		</>}
		{error && <div role="alert" className="space-y-2 text-sm text-red-700"><p>{t(original ? "writing.saveFailed" : "writing.loadFailed")}</p>{!original && <button type="button" className="min-h-11 font-medium underline" onClick={() => { setLoading(true); setError(false); setAttempt(value => value + 1); }}>{t("refine.retry")}</button>}</div>}
	</div>;
}
