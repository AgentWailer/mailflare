"use client";

import { useLanguage } from "@/components/language-provider";

export function AccountStatus({ disabled }: { disabled?: boolean }) {
	const { t } = useLanguage();
	return <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${disabled
		? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
		: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"}`}>
		<span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${disabled ? "bg-neutral-400" : "bg-green-600 dark:bg-green-400"}`} />
		{t(disabled ? "accounts.status.disabled" : "accounts.status.enabled")}
	</span>;
}
