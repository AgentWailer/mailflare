"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Columns2 } from "lucide-react";
import clsx from "clsx";
import { useLanguage } from "@/components/language-provider";
import { Tooltip } from "@/components/ui/tooltip";
import { useMessageListVisibility } from "./message-list-visibility";
import type { MessageReadingHeaderButtonProps } from "./message-reading-header-button-types";
import { useMessageOpening } from "./message-opening";

export function MessageReadingHeaderButton({ assistantVisible }: MessageReadingHeaderButtonProps) {
	const { t } = useLanguage();
	const router = useRouter();
	const opening = useMessageOpening();
	const { visible, toggle, singleColumn, backHref, backLabel } = useMessageListVisibility();
	const label = singleColumn
		? t("message.nav.backTo", { folder: backLabel })
		: assistantVisible ? null : visible ? t("message.nav.hideList") : t("message.nav.showList");

	function handleClick() {
		if (singleColumn) { opening?.cancel(); router.push(backHref); }
		else toggle();
	}

	return (
		<>
		<Tooltip label={t("message.nav.backTo", { folder: backLabel })} className="inline-flex lg:hidden">
			<button type="button" data-message-back onClick={() => { opening?.cancel(); router.push(backHref); }} aria-label={t("message.nav.backTo", { folder: backLabel })} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100">
				<ArrowLeft size={20} />
			</button>
		</Tooltip>
		<Tooltip label={label} className="hidden lg:inline-flex">
			<button
				type="button"
				className={clsx(!singleColumn && assistantVisible ? "opacity-40" : !singleColumn && !visible ? "opacity-60 hover:opacity-100" : "", (singleColumn || !assistantVisible) && "hover:bg-neutral-100 hover:text-neutral-900", "relative z-10 shrink-0 rounded-full p-2 text-neutral-600 duration-200")}
				onClick={handleClick}
				disabled={!singleColumn && assistantVisible}
				aria-label={label ?? t("message.nav.listUnavailable")}
				aria-pressed={singleColumn ? undefined : visible}
			>
				{singleColumn ? <ArrowLeft size={18} /> : <Columns2 size={18} />}
			</button>
		</Tooltip>
		</>
	);
}
