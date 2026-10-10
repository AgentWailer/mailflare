"use client";

import { FORK_SOURCE_URL } from "@/lib/fork";
import { useLanguage } from "@/components/language-provider";

/** Keep the source offer visible even when custom branding is enabled. */
export function ForkSource() {
	const { t } = useLanguage();
	return <footer className="px-4 py-3 text-center text-xs text-neutral-500"><a href={FORK_SOURCE_URL} target="_blank" rel="noreferrer" className="underline">{t("fork.source")}</a></footer>;
}
