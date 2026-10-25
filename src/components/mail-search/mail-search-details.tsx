"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { parseSearchQuery, setSearchIncludeSpam } from "@/lib/search/query-utils";

export function MailSearchDetails({ query, onChange }: { query: string; onChange: (query: string) => void }) {
	const { t } = useLanguage();
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [includeSpam, setIncludeSpam] = useState(false);
	const spamIncluded = !!parseSearchQuery(query).includeSpam;
	return <Dialog open={open} onOpenChange={next => {
		if (next) { setText(setSearchIncludeSpam(query, false)); setIncludeSpam(spamIncluded); }
		setOpen(next);
	}}>
		<DialogTrigger asChild><button type="button" aria-label={t("search.advanced")} title={t("search.advanced")} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-neutral-200 ${spamIncluded ? "bg-blue-100 text-blue-700" : "text-neutral-500"}`}><SlidersHorizontal className="h-5 w-5" /></button></DialogTrigger>
		<DialogContent className="max-md:top-auto max-md:bottom-0 max-md:w-full max-md:max-h-[85dvh] max-md:translate-y-0 max-md:rounded-b-none max-md:pb-[max(24px,env(safe-area-inset-bottom))]">
			<DialogHeader><DialogTitle>{t("search.advanced")}</DialogTitle><DialogDescription>{t("search.scopeHint")}</DialogDescription></DialogHeader>
			<form className="space-y-5" onSubmit={event => { event.preventDefault(); onChange(setSearchIncludeSpam(text, includeSpam)); setOpen(false); }}>
				<label className="block space-y-2 text-sm font-medium"><span>{t("search.mail")}</span><Input value={text} onChange={event => setText(event.target.value)} autoFocus /></label>
				<label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-neutral-200 px-3 py-2 text-sm"><Checkbox checked={includeSpam} onChange={event => setIncludeSpam(event.target.checked)} /><span>{t("search.includeSpam")}</span></label>
				<div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button><Button type="submit">{t("search.apply")}</Button></div>
			</form>
		</DialogContent>
	</Dialog>;
}
