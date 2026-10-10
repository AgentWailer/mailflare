"use client";

import Link from "next/link";
import { useLanguage } from "@/components/language-provider";

export function LicenseIndicator() {
	const { t } = useLanguage();
	return <Link href="/licenses" className="rounded-full bg-green-100 px-4 py-2 text-[11px] font-semibold text-green-900 hover:bg-green-200">{t("fork.unlocked")}</Link>;
}
