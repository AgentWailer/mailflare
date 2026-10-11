"use client";

import { useContext } from "react";
import { FileText, Languages } from "lucide-react";
import { AssistantRequestContext } from "@/components/agent/assistant-open-state";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useLanguage } from "@/components/language-provider";
import type { Message } from "@/hooks/types";

export function MessageAiShortcuts({ message, compact = false }: { message: Message; compact?: boolean }) {
	const request = useContext(AssistantRequestContext);
	const { selectedMailbox } = useSelectedMailbox();
	const { t } = useLanguage();
	if (!request || !message.mailboxId || message.mailboxId !== selectedMailbox?.id) return null;
	return <div data-message-ai data-compact={compact || undefined} className={`flex shrink-0 flex-wrap ${compact ? "gap-0 sm:gap-1" : "gap-1"}`}>
		{(["summary", "translate"] as const).map(action => {
			const Icon = action === "summary" ? FileText : Languages;
			const label = t(action === "summary" ? "message.ai.summary" : "message.ai.translate");
			return <button key={action} type="button" aria-label={label} title={label}
				className={compact ? "inline-flex h-8 w-8 items-center justify-center rounded-full text-blue-700 hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-500" : "inline-flex min-h-9 items-center gap-1.5 rounded-full border border-neutral-200 px-3 text-xs text-blue-700 hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-500"}
				onClick={() => request({ mailboxId: message.mailboxId!, messageId: message.id, action, prompt: t(action === "summary" ? "message.ai.summaryPrompt" : "message.ai.translatePrompt", { id: message.id }) })}>
				<Icon aria-hidden="true" className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />{!compact && label}
			</button>;
		})}
	</div>;
}
