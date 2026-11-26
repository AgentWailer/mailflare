"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { ComposeForm } from "@/components/compose/compose-form";
import { prefillFromSearchParams } from "@/components/compose/mailto-utils";

export default function ComposePage() {
	const { t } = useLanguage();
	const params = useSearchParams();
	// `?mailto=` is how the browser hands over a clicked mailto link once Mailflare is the mail program.
	const query = params.toString();
	const initial = useMemo(() => prefillFromSearchParams(new URLSearchParams(query)), [query]);
	return (
		<div className="compose-page-container flex h-full min-h-0 flex-col overflow-hidden p-2 md:overflow-auto md:p-8">
			<div className="compose-page-title mb-6 hidden md:block">
				<h1 className="text-2xl font-normal text-neutral-900">{t("compose.pageTitle")}</h1>
				<p className="mt-1 text-sm text-neutral-500">{t("compose.pageDescription")}</p>
			</div>
			<ComposeForm key={query} mode="page" initial={initial} />
		</div>
	);
}
