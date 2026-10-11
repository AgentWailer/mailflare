"use client";

import { usePathname } from "next/navigation";
import { Pencil } from "lucide-react";
import { useCompose } from "./compose-context";
import { useLanguage } from "@/components/language-provider";

export function MobileComposeButton({ hidden = false }: { hidden?: boolean }) {
	const pathname = usePathname();
	const { open, openComposer } = useCompose();
	const { t } = useLanguage();
	const mailList = /^\/(inbox|all|promotions|social|starred|snoozed|sent|scheduled|drafts|archived|spam|trash)\/?$/.test(pathname) || /^\/folders\/[^/]+\/?$/.test(pathname);
	if (!mailList || open || hidden) return null;
	return <button type="button" data-mobile-compose onClick={openComposer} className="fixed right-4 z-30 flex min-h-14 items-center gap-3 rounded-2xl bg-blue-600 px-5 py-4 text-sm font-medium text-white shadow-lg md:hidden" style={{ bottom: "calc(1.25rem + env(safe-area-inset-bottom, 0px))" }}><Pencil className="h-6 w-6" />{t("navigation.composeMobile")}</button>;
}
