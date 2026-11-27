"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { MAILTO_HANDLER_PATH } from "@/components/compose/mailto-utils";

/**
 * Offers Mailflare to the browser as the program for mail links (`mailto:`), so
 * an address clicked on any web page starts a message here. The browser asks
 * the user itself; it does not say what they answered, so nothing is claimed.
 */
export function MailLinkSettings() {
	const { t } = useLanguage();
	const [state, setState] = useState<"idle" | "asked" | "failed">("idle");
	const supported = typeof navigator !== "undefined" && typeof navigator.registerProtocolHandler === "function";
	return <div className="space-y-3">
		<p className="text-sm text-neutral-500">{t("settings.mailLinks.description")}</p>
		{supported ? <>
			<Button type="button" variant="outline" className="min-h-11" onClick={() => {
				try { navigator.registerProtocolHandler("mailto", `${window.location.origin}${MAILTO_HANDLER_PATH}`); setState("asked"); }
				catch { setState("failed"); }
			}}>{t("settings.mailLinks.action")}</Button>
			{state === "asked" && <p role="status" className="text-sm text-neutral-600">{t("settings.mailLinks.asked")}</p>}
			{state === "failed" && <p role="alert" className="text-sm text-red-700">{t("settings.mailLinks.failed")}</p>}
		</> : <p className="text-sm text-neutral-600">{t("settings.mailLinks.unsupported")}</p>}
	</div>;
}
