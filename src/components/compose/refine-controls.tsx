"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import { REFINE_TEXT_LIMIT, REFINE_HISTORY_LIMIT } from "@/lib/agent/refine-input";
import type { RefineReplyContext } from "@/lib/agent/refine-input";
import type { TranslationKey } from "@/lib/i18n/types";
import type { RefinePreferences } from "./refine-preferences";
import type { RefineTarget } from "./refine-utils";

const ERRORS: Record<string, TranslationKey> = {
	unauthorized: "refine.unauthorized", forbidden: "refine.forbidden", disabled: "refine.disabled",
	not_configured: "refine.notConfigured", rate_limit: "refine.rateLimit", too_long: "refine.tooLong",
	invalid_request: "refine.failed", provider_error: "refine.failed", truncated: "refine.truncated", invalid_output: "refine.invalidOutput",
	history_missing: "refine.historyMissing", history_too_long: "refine.historyTooLong",
};

export function RefineControls({ mailboxId, selection, message, draftReply, replyContext, instruction, preferences, onApply, onClose }: {
 mailboxId: string;
 selection: RefineTarget | null;
 message: RefineTarget | null;
 draftReply: boolean;
 replyContext?: RefineReplyContext;
 instruction: string;
 preferences: RefinePreferences;
 onApply: (target: RefineTarget, text: string) => boolean;
 onClose: () => void;
}) {
 const { t } = useLanguage();
	const [generation, setGeneration] = useState(0);
	const [error, setError] = useState<TranslationKey | null>(null);
	const [pending, setPending] = useState(true);
	const target = selection ?? message;
	const { mode, language } = preferences;
	const hasHistory = !!(replyContext?.threadId || replyContext?.inReplyTo || replyContext?.quotedText?.trim());
	const callbacks = useRef({ onApply, onClose });
	useEffect(() => { callbacks.current = { onApply, onClose }; });

	// One click starts immediately; changing an option or retrying starts a fresh request.
	useEffect(() => {
		const request = new AbortController();
		void Promise.resolve().then(async () => {
			if (request.signal.aborted) return;
			setError(null); setPending(true);
			if (draftReply && !hasHistory && !instruction) { setError("refine.historyMissing"); setPending(false); return; }
			if (draftReply && (replyContext?.quotedText?.length ?? 0) > REFINE_HISTORY_LIMIT) { setError("refine.historyTooLong"); setPending(false); return; }
			if (!target || target.text.length > REFINE_TEXT_LIMIT || target.images.length > 100) {
				setError(target ? "refine.tooLong" : "refine.empty"); setPending(false);
				return;
			}
			try {
				const response = await authFetch("/api/compose/refine", {
					method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
					body: JSON.stringify({ mailboxId, text: target.text, mode, language, protectedTokens: target.images.map(image => image.token), instruction, ...(draftReply ? { action: hasHistory ? "reply" : "compose", replyContext } : {}) }),
					redirectOnUnauthorized: false,
				});
				const data = await response.json() as { text?: string; code?: string };
				if (request.signal.aborted) return;
				if (!response.ok) { setError(ERRORS[data.code ?? ""] ?? "refine.failed"); return; }
				if (typeof data.text !== "string" || !data.text.trim()) { setError("refine.invalidOutput"); return; }
				if (!callbacks.current.onApply(target, data.text)) { setError("refine.changed"); return; }
				callbacks.current.onClose();
			} catch { if (!request.signal.aborted) setError("refine.failed"); }
			finally { if (!request.signal.aborted) setPending(false); }
		});
		return () => request.abort();
	}, [mailboxId, target, mode, language, generation, draftReply, replyContext, hasHistory, instruction]);

 return <div data-compose-ai-pending className="mx-4 mb-2 shrink-0 rounded-2xl bg-blue-50 px-3 py-2" aria-label={t("refine.title")}>
  {error && <p role="alert" className="mb-1 text-sm text-red-700">{t(error)}</p>}
  <div className="flex flex-wrap items-center gap-2">
   {pending && <span role="status" className="flex min-w-0 flex-1 items-center gap-2 text-sm text-blue-700"><Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"/>{t(draftReply ? "refine.replyWorking" : "refine.working")}</span>}
   {!pending && <Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-9" onClick={() => setGeneration(value => value + 1)}><RotateCw className="h-4 w-4"/>{t("refine.retry")}</Button>}
   <Button type="button" variant="ghost" size="sm" className="ml-auto min-h-11 md:min-h-9" onClick={onClose}>{t("refine.cancel")}</Button>
  </div>
 </div>;
}
