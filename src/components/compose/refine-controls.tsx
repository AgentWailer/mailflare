"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, RotateCw, SlidersHorizontal } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import { REFINE_TEXT_LIMIT, REFINE_HISTORY_LIMIT } from "@/lib/agent/refine-input";
import type { RefineInput, RefineReplyContext } from "@/lib/agent/refine-input";
import type { TranslationKey } from "@/lib/i18n/types";
import { readRefinePreferences, saveRefinePreferences } from "./refine-preferences";
import type { RefineTarget } from "./refine-utils";

const MODES: Array<{ value: RefineInput["mode"]; key: TranslationKey }> = [
	{ value: "polish", key: "refine.polish" }, { value: "professional", key: "refine.professional" },
	{ value: "friendly", key: "refine.friendly" }, { value: "shorter", key: "refine.shorter" }, { value: "longer", key: "refine.longer" },
];
const ERRORS: Record<string, TranslationKey> = {
	unauthorized: "refine.unauthorized", forbidden: "refine.forbidden", disabled: "refine.disabled",
	not_configured: "refine.notConfigured", rate_limit: "refine.rateLimit", too_long: "refine.tooLong",
	invalid_request: "refine.failed", provider_error: "refine.failed", truncated: "refine.truncated", invalid_output: "refine.invalidOutput",
	history_missing: "refine.historyMissing", history_too_long: "refine.historyTooLong",
};

export function RefineControls({ mailboxId, selection, message, draftReply, replyContext, onPreview, onApply, onClose }: {
	mailboxId: string;
	selection: RefineTarget | null;
	message: RefineTarget | null;
	draftReply: boolean;
	replyContext?: RefineReplyContext;
	onPreview: (target: RefineTarget | null, text: string | null) => boolean;
	onApply: (target: RefineTarget, text: string) => boolean;
	onClose: () => void;
}) {
	const { t } = useLanguage();
	const id = useId();
	const [scope, setScope] = useState<"selection" | "message">(selection ? "selection" : "message");
	const [preferences, setPreferences] = useState(readRefinePreferences);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [generation, setGeneration] = useState(0);
	const [result, setResult] = useState("");
	const [error, setError] = useState<TranslationKey | null>(null);
	const [pending, setPending] = useState(true);
	const target = scope === "selection" ? selection : message;
	const { mode, language } = preferences;
	const hasHistory = !!(replyContext?.threadId || replyContext?.inReplyTo || replyContext?.quotedText?.trim());
	const callbacks = useRef({ onPreview, onApply, onClose });
	useEffect(() => { callbacks.current = { onPreview, onApply, onClose }; });

	// One click starts immediately; changing an option or retrying starts a fresh request.
	useEffect(() => {
		const request = new AbortController();
		saveRefinePreferences({ mode, language });
		void Promise.resolve().then(async () => {
			if (request.signal.aborted) return;
			setResult(""); setError(null); setPending(true);
			callbacks.current.onPreview(null, null);
			if (draftReply && !hasHistory) { setError("refine.historyMissing"); setPending(false); return; }
			if (draftReply && (replyContext?.quotedText?.length ?? 0) > REFINE_HISTORY_LIMIT) { setError("refine.historyTooLong"); setPending(false); return; }
			if (!target || target.text.length > REFINE_TEXT_LIMIT || target.images.length > 100) {
				setError(target ? "refine.tooLong" : "refine.empty"); setPending(false);
				return;
			}
			try {
				const response = await authFetch("/api/compose/refine", {
					method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
					body: JSON.stringify({ mailboxId, text: target.text, mode, language, protectedTokens: target.images.map(image => image.token), ...(draftReply ? { action: "reply", replyContext } : {}) }),
					redirectOnUnauthorized: false,
				});
				const data = await response.json() as { text?: string; code?: string };
				if (request.signal.aborted) return;
				if (!response.ok) { setError(ERRORS[data.code ?? ""] ?? "refine.failed"); return; }
				if (typeof data.text !== "string" || !data.text.trim()) { setError("refine.invalidOutput"); return; }
				if (!callbacks.current.onPreview(target, data.text)) { setError("refine.changed"); return; }
				setResult(data.text);
			} catch { if (!request.signal.aborted) setError("refine.failed"); }
			finally { if (!request.signal.aborted) setPending(false); }
		});
		return () => request.abort();
	}, [mailboxId, target, mode, language, generation, draftReply, replyContext, hasHistory]);

	return (
		<div className="shrink-0 border-t border-blue-100 bg-blue-50/60 px-3 py-2" aria-label={t("refine.title")}>
			{error && <p role="alert" className="mb-2 text-sm text-red-700">{t(error)}</p>}
			<div className="flex flex-wrap items-center gap-1.5">
				{pending ? <span role="status" className="flex min-w-0 flex-1 items-center gap-2 text-xs text-blue-700"><Loader2 className="h-4 w-4 shrink-0 animate-spin" />{t(draftReply ? "refine.replyWorking" : "refine.working")}</span> : <span role="status" className="sr-only">{result ? t("refine.preview") : ""}</span>}
				{!!result && <Button type="button" size="sm" className="min-h-10 md:min-h-8" onClick={() => {
					if (target && callbacks.current.onApply(target, result)) callbacks.current.onClose();
					else setError("refine.changed");
				}}>{t("refine.apply")}</Button>}
				{!pending && <Button type="button" variant="ghost" size="sm" className="min-h-10 md:min-h-8" disabled={!target || draftReply && !hasHistory} onClick={() => setGeneration(value => value + 1)}><RotateCw className="h-3.5 w-3.5" />{t("refine.retry")}</Button>}
				<Button type="button" variant="ghost" size="sm" className="min-h-10 md:min-h-8" onClick={onClose}>{t("refine.cancel")}</Button>
				<button type="button" aria-label={t("refine.settings")} aria-expanded={settingsOpen} aria-controls={`${id}-settings`} onClick={() => setSettingsOpen(open => !open)} className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-blue-700 hover:bg-blue-100 md:h-8 md:w-8"><SlidersHorizontal className="h-4 w-4" /></button>
			</div>
			{settingsOpen && <div id={`${id}-settings`} className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">
				{selection && <label className="col-span-2 space-y-1 text-xs text-neutral-600 md:col-span-1">{t("refine.scope")}<select aria-label={t("refine.scope")} value={scope} onChange={event => setScope(event.target.value as typeof scope)} className="block min-h-10 w-full rounded-lg border border-blue-100 bg-white px-2 text-base md:min-h-8 md:text-sm"><option value="selection">{t("refine.selection")}</option><option value="message">{t("refine.message")}</option></select></label>}
				<label className="space-y-1 text-xs text-neutral-600">{t("refine.style")}<select aria-label={t("refine.style")} value={mode} onChange={event => setPreferences(current => ({ ...current, mode: event.target.value as typeof mode }))} className="block min-h-10 w-full rounded-lg border border-blue-100 bg-white px-2 text-base md:min-h-8 md:text-sm">{MODES.map(item => <option key={item.value} value={item.value}>{t(item.key)}</option>)}</select></label>
				<label className="space-y-1 text-xs text-neutral-600">{t("refine.language")}<select aria-label={t("refine.language")} value={language} onChange={event => setPreferences(current => ({ ...current, language: event.target.value as typeof language }))} className="block min-h-10 w-full rounded-lg border border-blue-100 bg-white px-2 text-base md:min-h-8 md:text-sm"><option value="keep">{t("refine.keepLanguage")}</option><option value="de">Deutsch</option><option value="en">English</option></select></label>
			</div>}
		</div>
	);
}
