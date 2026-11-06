"use client";

import { useId } from "react";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Languages } from "lucide-react";
import { locales, supportedLocales } from "@/lib/i18n/locales";
import { getDirection, resolveLocale } from "@/lib/i18n/utils";
import { useLanguage } from "./language-provider";

export function LanguageSelector({ variant = "field" }: { variant?: "field" | "text" }) {
	const id = useId();
	const { locale, setLocale, t } = useLanguage();
	const text = variant === "text";

	return (
		<div className={text ? "inline-flex min-w-0" : "flex min-w-0 flex-col gap-2"}>
			{!text && <label htmlFor={id} className="text-xs font-medium text-neutral-600">{t("language.label")}</label>}
			<Select.Root dir={getDirection(locale)} value={locale} onValueChange={(value) => setLocale(resolveLocale(value))}>
				<Select.Trigger id={id} aria-label={t("language.label")} className={`group flex min-h-11 min-w-0 items-center gap-2 rounded-lg text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${text
					? "px-2 font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950"
					: "w-full border border-neutral-300 bg-[var(--card)] px-3 text-[var(--foreground)] hover:border-neutral-400 data-[state=open]:border-blue-600"}`}>
					<Languages className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate text-start"><Select.Value><span lang={locale}>{locales[locale].label}</span></Select.Value></span>
					<Select.Icon asChild><ChevronDown className="h-4 w-4 shrink-0 text-neutral-500 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" /></Select.Icon>
				</Select.Trigger>
				<Select.Portal>
					<Select.Content position="popper" align="start" sideOffset={6} collisionPadding={12} className="z-[200] min-w-[max(13rem,var(--radix-select-trigger-width))] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-lg">
						<Select.Viewport className="max-h-[min(20rem,var(--radix-select-content-available-height))] overscroll-contain p-1">
							{supportedLocales.map((value) => (
								<Select.Item key={value} value={value} className="relative flex min-h-11 cursor-default select-none items-center rounded-lg py-2 ps-3 pe-9 text-sm outline-none data-[highlighted]:bg-[var(--muted)] data-[state=checked]:font-medium data-[state=checked]:text-blue-700 dark:data-[state=checked]:text-blue-400">
									<Select.ItemText><span lang={value}>{locales[value].label}</span></Select.ItemText>
									<Select.ItemIndicator className="absolute end-3"><Check className="h-4 w-4" aria-hidden="true" /></Select.ItemIndicator>
								</Select.Item>
							))}
						</Select.Viewport>
					</Select.Content>
				</Select.Portal>
			</Select.Root>
		</div>
	);
}
