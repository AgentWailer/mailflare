"use client";

import { ChevronDown } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import type { Message } from "@/hooks/types";

export function MessageEnvelopeDetails({ message, mailboxAddress, compact = false }: { message: Message; mailboxAddress?: string; compact?: boolean }) {
	const { t } = useLanguage();
	const fields = [[t("source.from"), message.fromAddr], [t("source.to"), message.toAddr], [t("message.cc"), message.ccAddr], [t("message.bcc"), message.bccAddr], [t("message.details.mailbox"), mailboxAddress], [t("message.details.date"), formatUserDate(message.createdAt, { dateStyle: "medium", timeStyle: "short" })]];
	return <details data-message-envelope data-compact={compact || undefined} className="min-w-0 text-xs text-neutral-600 open:basis-full">
		<summary title={t("message.details")} className={`flex min-h-6 cursor-pointer list-none items-center justify-center gap-1 rounded hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden ${compact ? "w-6" : "w-fit"}`}><span className={compact ? "sr-only" : undefined}>{t("message.details")}</span><ChevronDown aria-hidden="true" className="h-3 w-3" /></summary>
		<dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-neutral-200 bg-neutral-50 p-3">{fields.filter(([, value]) => !!value).map(([label, value]) => <div className="contents" key={label}><dt className="text-neutral-500">{label}</dt><dd className="min-w-0 break-all text-neutral-800">{value}</dd></div>)}</dl>
	</details>;
}
