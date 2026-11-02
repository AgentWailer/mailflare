"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import type { QueueFailureStatus } from "@/lib/queues/failures-types";

export function AdminQueueHealthCard() {
	const { t, locale } = useLanguage();
	const [status, setStatus] = useState<QueueFailureStatus>();
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const refresh = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await authFetch("/api/admin/queue-health", { signal, cache: "no-store" });
			if (!response.ok) throw new Error("queue_status_unavailable");
			const next = await response.json() as QueueFailureStatus;
			if (!signal?.aborted) setStatus(next);
		} catch {
			if (!signal?.aborted) setFailed(true);
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		// refresh only changes state after the authenticated network request settles.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void refresh(controller.signal);
		return () => controller.abort();
	}, [refresh]);

	return (
		<section className="mb-6 rounded-2xl border border-neutral-200 bg-white p-4 sm:p-5" aria-labelledby="queue-health-title" aria-busy={loading}>
			<div className="flex items-center justify-between gap-3">
				<h2 id="queue-health-title" className="flex items-center gap-2 text-base font-medium">
					{!!status?.count && <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />}
					{t("queueHealth.title")}
				</h2>
				<button type="button" onClick={() => { setLoading(true); setFailed(false); void refresh(); }} disabled={loading} aria-label={t("queueHealth.refresh")} title={t("queueHealth.refresh")} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50">
					<RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? "motion-safe:animate-spin" : ""}`} />
				</button>
			</div>
			<p role="status" className={`mt-2 text-sm ${failed ? "text-red-700" : status?.count ? "text-amber-800" : "text-neutral-600"}`}>
				{failed ? t("queueHealth.failedLoad") : !status ? t("queueHealth.loading") : status.count ? t(status.hasMore ? "queueHealth.warningMore" : "queueHealth.warning", { count: status.count }) : t("queueHealth.clear")}
			</p>
			{status && !failed && <p className="mt-2 text-xs text-neutral-500">{t("queueHealth.scope")}</p>}
			{!!status?.count && (
				<details className="mt-3 text-sm">
					<summary className="cursor-pointer py-1 font-medium text-neutral-700">{t("queueHealth.recent")}</summary>
					<ul className="mt-2 divide-y divide-neutral-100">
						{status.recent.map((notice, index) => (
							<li key={`${notice.createdAt}-${index}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
								<span>{t(`queueHealth.kind.${notice.kind}`)}</span>
								<span className="text-xs text-neutral-500"><time dateTime={notice.createdAt}>{new Date(notice.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</time> · {t("queueHealth.attempts", { count: notice.attempts })}</span>
							</li>
						))}
					</ul>
					<p className="mt-3 text-neutral-600">{t("queueHealth.recovery")}</p>
				</details>
			)}
		</section>
	);
}
