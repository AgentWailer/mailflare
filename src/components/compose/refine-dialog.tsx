"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import { REFINE_TEXT_LIMIT } from "@/lib/agent/refine-input";
import type { RefineInput } from "@/lib/agent/refine-input";
import type { TranslationKey } from "@/lib/i18n/types";
import type { RefineTarget } from "./refine-utils";

const MODES: Array<{ value: RefineInput["mode"]; key: TranslationKey }> = [
	{ value: "polish", key: "refine.polish" },
	{ value: "professional", key: "refine.professional" },
	{ value: "friendly", key: "refine.friendly" },
	{ value: "shorter", key: "refine.shorter" },
	{ value: "longer", key: "refine.longer" },
];
const ERRORS: Record<string, TranslationKey> = {
	unauthorized: "refine.unauthorized", forbidden: "refine.forbidden", disabled: "refine.disabled",
	not_configured: "refine.notConfigured", rate_limit: "refine.rateLimit", too_long: "refine.tooLong",
	invalid_request: "refine.failed", provider_error: "refine.failed", truncated: "refine.truncated", invalid_output: "refine.invalidOutput",
};

export function RefineDialog({ mailboxId, selection, message, onApply, onClose }: {
	mailboxId: string;
	selection: RefineTarget | null;
	message: RefineTarget | null;
	onApply: (target: RefineTarget, text: string) => boolean;
	onClose: () => void;
}) {
	const { t } = useLanguage();
	const id = useId();
	const [scope, setScope] = useState<"selection" | "message">(selection ? "selection" : "message");
	const [mode, setMode] = useState<RefineInput["mode"]>("polish");
	const [language, setLanguage] = useState<RefineInput["language"]>("keep");
	const [result, setResult] = useState("");
	const [error, setError] = useState<TranslationKey | null>(null);
	const [pending, setPending] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const target = scope === "selection" ? selection : message;
	const tooLong = (target?.text.length ?? 0) > REFINE_TEXT_LIMIT || (target?.images.length ?? 0) > 100;

	function resetResult() { setResult(""); setError(null); }
	async function generate() {
		if (!target || tooLong || controller.current) return;
		resetResult(); setPending(true);
		const request = new AbortController(); controller.current = request;
		try {
			const response = await authFetch("/api/compose/refine", {
				method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
				body: JSON.stringify({ mailboxId, text: target.text, mode, language, protectedTokens: target.images.map(image => image.token) }),
				redirectOnUnauthorized: false,
			});
			const data = await response.json() as { text?: string; code?: string };
			if (!response.ok) { setError(ERRORS[data.code ?? ""] ?? "refine.failed"); return; }
			if (!data.text?.trim()) { setError("refine.invalidOutput"); return; }
			setResult(data.text);
		} catch { if (!request.signal.aborted) setError("refine.failed"); }
		finally { if (!request.signal.aborted) setPending(false); controller.current = null; }
	}

	const preview = target?.images.reduce((text, image) => text.replace(image.token, t("refine.image")), result) ?? result;
	return (
		<Dialog open onOpenChange={open => { if (!open) onClose(); }}>
			<DialogContent className="w-[min(640px,calc(100vw-32px))] max-h-[85dvh] overflow-y-auto" onCloseAutoFocus={event => event.preventDefault()}>
				<DialogHeader>
					<DialogTitle>{t("refine.title")}</DialogTitle>
					<DialogDescription>{t("refine.description")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="grid gap-3 sm:grid-cols-3">
						<label htmlFor={`${id}-scope`} className="space-y-1 text-sm"><span>{t("refine.scope")}</span>
							<select id={`${id}-scope`} value={scope} disabled={pending} onChange={event => { setScope(event.target.value as typeof scope); resetResult(); }} className="w-full rounded-lg border border-neutral-200 bg-white p-2">
								<option value="selection" disabled={!selection}>{t("refine.selection")}</option>
								<option value="message">{t("refine.message")}</option>
							</select>
						</label>
						<label htmlFor={`${id}-mode`} className="space-y-1 text-sm"><span>{t("refine.style")}</span>
							<select id={`${id}-mode`} value={mode} disabled={pending} onChange={event => { setMode(event.target.value as typeof mode); resetResult(); }} className="w-full rounded-lg border border-neutral-200 bg-white p-2">
								{MODES.map(item => <option key={item.value} value={item.value}>{t(item.key)}</option>)}
							</select>
						</label>
						<label htmlFor={`${id}-language`} className="space-y-1 text-sm"><span>{t("refine.language")}</span>
							<select id={`${id}-language`} value={language} disabled={pending} onChange={event => { setLanguage(event.target.value as typeof language); resetResult(); }} className="w-full rounded-lg border border-neutral-200 bg-white p-2">
								<option value="keep">{t("refine.keepLanguage")}</option><option value="de">Deutsch</option><option value="en">English</option>
							</select>
						</label>
					</div>
					{!target && <p role="status" className="text-sm text-neutral-600">{t("refine.empty")}</p>}
					{tooLong && <p role="alert" className="text-sm text-red-600">{t("refine.tooLong")}</p>}
					{error && <p role="alert" className="text-sm text-red-600">{t(error)}</p>}
					{pending && <p role="status" className="flex items-center gap-2 text-sm text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" />{t("refine.working")}</p>}
					{!!result && <div className="space-y-1"><label htmlFor={`${id}-preview`} className="text-sm font-medium">{t("refine.preview")}</label><textarea id={`${id}-preview`} readOnly value={preview} className="min-h-48 max-h-80 w-full resize-y rounded-xl border border-neutral-200 p-3 text-sm" /></div>}
					<div className="flex flex-wrap justify-end gap-2">
						<Button type="button" variant="ghost" size="sm" onClick={onClose}>{t("refine.cancel")}</Button>
						<Button type="button" variant="outline" size="sm" disabled={pending || !target || tooLong} onClick={() => void generate()}><Sparkles className="h-4 w-4" />{result ? t("refine.retry") : t("refine.generate")}</Button>
						{!!result && <Button type="button" size="sm" disabled={pending} onClick={() => { if (target && onApply(target, result)) onClose(); else setError("refine.changed"); }}>{t("refine.apply")}</Button>}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
