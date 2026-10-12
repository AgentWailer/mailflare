"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { isPrimaryInboxMail } from "@/lib/mail-sorting/categories";
import type { Message } from "@/hooks/types";

export function MessageReaderLabels({ message }: { message: Message }) {
	const { t } = useLanguage();
	const client = useQueryClient();
	const key = ["message-reader-labels", message.mailboxId, message.id];
	const { data } = useQuery({ queryKey: key, enabled: !!message.mailboxId, queryFn: async () => {
		const params = new URLSearchParams({ mailboxId: message.mailboxId!, messageId: message.id });
		const response = await authFetch(`/api/mail-organization?${params}`);
		if (!response.ok) throw new Error("Unable to load message labels");
		const result = await response.json() as { messages: Message[] };
		return result.messages[0];
	}});
	useEffect(() => {
		const refresh = () => { void client.invalidateQueries({ queryKey: ["message-reader-labels", message.mailboxId, message.id] }); };
		window.addEventListener("mailflare:messages-changed", refresh);
		return () => window.removeEventListener("mailflare:messages-changed", refresh);
	}, [client, message.mailboxId, message.id]);
	const current = { ...message, ...data };
	const category = current.category;
	const systemLabel = current.status === "spam" ? "navigation.spam" : current.status === "trash" ? "navigation.trash" : current.status === "archived" ? "navigation.archived" : category === "promotions" ? "smart.promotions" : category === "social" ? "smart.social" : category === "invoices" ? "smart.invoices" : category === "orders" ? "smart.orders" : isPrimaryInboxMail(current) ? "smart.primary" : "message.categories.primary";
	const labels = data?.labels ?? message.labels ?? [];
	return <div data-reader-labels className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label={t("smart.labels")}>
		{message.direction === "inbound" && category && <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-normal text-blue-700">{t(systemLabel)}</span>}
		{message.direction === "inbound" && current.status === "archived" && (category === "invoices" || category === "orders") && <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-normal text-blue-700">{t(category === "invoices" ? "smart.invoices" : "smart.orders")}</span>}
		{labels.map(label => <span key={label.id} className="inline-flex max-w-full items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-700"><span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} /><span className="break-words">{label.name}</span></span>)}
	</div>;
}
