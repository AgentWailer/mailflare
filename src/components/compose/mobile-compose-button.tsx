"use client";

import { usePathname } from "next/navigation";
import { Pencil } from "lucide-react";
import { useCompose } from "./compose-context";
import { useLanguage } from "@/components/language-provider";

export function MobileComposeButton({ hidden = false }: { hidden?: boolean }) {
	const pathname = usePathname();
	const { open, openComposer } = useCompose();
	const { t } = useLanguage();
	const mailList = /^\/(inbox|all|promotions|social|invoices|orders|starred|snoozed|sent|scheduled|drafts|archived|spam|trash)\/?$/.test(pathname) || /^\/folders\/[^/]+\/?$/.test(pathname);
	if (!mailList || open || hidden) return null;
	return <button type="button" data-mobile-compose aria-label={t("navigation.composeMobile")} title={t("navigation.composeMobile")} onClick={openComposer} className="fixed right-4 z-30 flex min-h-12 items-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-lg md:hidden" style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}><Pencil className="h-5 w-5" /><span className="sr-only">{t("navigation.composeMobile")}</span></button>;
}
