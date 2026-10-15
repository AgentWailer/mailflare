"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { MessageDetailSkeleton } from "@/components/page-skeletons";
import type { Message } from "@/hooks/types";

export function MessageOpeningPreview({ message, href }: { message: Message; href: string }) {
	const { t } = useLanguage();
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = window.setTimeout(() => setSlow(true), 15_000);
		return () => window.clearTimeout(timer);
	}, []);
	return <div data-message-opening role={slow ? "alert" : "status"} aria-label={t("nav.loadingPage")} className="min-h-0 flex-1 overflow-y-auto">
		<h1 className="px-4 pt-3 text-lg font-medium text-neutral-900">{message.subject}</h1>
		{slow ? <div className="space-y-3 p-4"><p className="text-sm text-neutral-600">{t("message.loadFailed")}</p><a data-message-retry href={href} className="inline-flex min-h-11 items-center rounded-xl border border-neutral-200 px-4 text-sm text-blue-700">{t("message.retry")}</a></div> : <MessageDetailSkeleton />}
	</div>;
}
