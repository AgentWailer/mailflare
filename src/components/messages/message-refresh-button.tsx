"use client";

import { RefreshCw } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

export function MessageRefreshButton({ onRefresh, refreshing, disabled = false }: { onRefresh: () => Promise<void>; refreshing: boolean; disabled?: boolean }) {
	const { t } = useLanguage();
	const label = t(refreshing ? "list.refreshing" : "list.refresh");
	return <Tooltip label={label} className="shrink-0"><Button type="button" variant="ghost" size="sm" className="h-11 w-11 shrink-0 px-0" aria-label={label} disabled={disabled || refreshing} onClick={() => void onRefresh()}><RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /></Button></Tooltip>;
}
