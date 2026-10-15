"use client";

import { usePathname, useRouter } from "next/navigation";
import { lazy, Suspense } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "@/components/compose/compose-context";

const ComposeForm = lazy(() => import("./compose-form").then(module => ({ default: module.ComposeForm })));

export function FloatingComposer() {
	const { open, draftId, closeComposer } = useCompose();
	const pathname = usePathname();
	const router = useRouter();
	const { t } = useLanguage();
	if (!open) return null;
	const close = () => {
		closeComposer();
		if (/^\/drafts\/[^/]+\/?$/.test(pathname)) router.replace("/drafts");
	};
	return <Suspense fallback={<div role="status" aria-label={t("nav.loading")} className="fixed inset-0 z-[160] flex flex-col bg-white p-4 md:inset-auto md:bottom-0 md:right-6 md:h-[60dvh] md:w-[560px] md:rounded-t-2xl md:shadow-xl"><div className="flex items-center justify-between"><span>{t("navigation.compose")}</span><button type="button" onClick={close} aria-label={t("navigation.close")} className="flex h-11 w-11 items-center justify-center"><X className="h-5 w-5" /></button></div><p className="m-auto text-sm text-neutral-500">{t("nav.loading")}</p></div>}><ComposeForm key={draftId ?? "new"} mode="popup" draftIdToLoad={draftId} onClose={close} /></Suspense>;
}
