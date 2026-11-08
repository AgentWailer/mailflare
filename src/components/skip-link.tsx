"use client";

import { useLanguage } from "@/components/language-provider";

/** First stop for keyboard users: jump past the menu to the page's main region. */
export function SkipLink() {
	const { t } = useLanguage();
	return (
		<a href="#main-content" className="skip-link sr-only rounded-lg bg-white px-4 py-2 text-sm font-medium text-blue-700 shadow-lg">
			{t("navigation.skipToContent")}
		</a>
	);
}
