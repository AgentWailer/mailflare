"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBranding } from "@/components/branding-provider";
import { useLanguage } from "@/components/language-provider";
import { PageLoadingContext } from "@/components/page-loading";
import { RouteLoadingBar } from "@/components/route-loading-bar";
import type { LoadingTransitionProps } from "./loading-transition-types";

let hasShownInitialLoadingTransition = false;

export function LoadingTransition({ children, ready }: LoadingTransitionProps) {
	const { t } = useLanguage();
	const branding = useBranding();
	const [showInitialLoader] = useState(() => !hasShownInitialLoadingTransition);
	const [progress, setProgress] = useState(8);
	const [failedIcon, setFailedIcon] = useState<string | null>(null);
	const [pageMounted, setPageMounted] = useState(false);
	const loaderVisible = showInitialLoader && !pageMounted;
	const contentVisible = !loaderVisible;
	const initialLoadComplete = !showInitialLoader || pageMounted;
	const iconUrl = failedIcon === branding.iconUrl ? "/icon-96.png" : branding.iconUrl;
	const [pendingLoads, setPendingLoads] = useState(0);
	const loadingIds = useRef(new Set<string>());

	const reportLoading = useCallback((id: string, loading: boolean) => {
		if (loading) loadingIds.current.add(id);
		else loadingIds.current.delete(id);
		setPendingLoads(loadingIds.current.size);
	}, []);
	const loadingContext = useMemo(() => ({ reportLoading }), [reportLoading]);
	// Authentication gates the shell; mailbox data has local loaders and must not hide the menu.
	const canComplete = ready && pageMounted;

	useEffect(() => {
		if (canComplete) return;
		const timer = window.setInterval(() => {
			setProgress((current) => Math.min(92, current + Math.max(1, (92 - current) * 0.08)));
		}, 90);
		return () => window.clearInterval(timer);
	}, [canComplete]);

	useEffect(() => {
		if (!ready) return;
		const frame = window.requestAnimationFrame(() => setPageMounted(true));
		return () => window.cancelAnimationFrame(frame);
	}, [ready]);

	useEffect(() => {
		if (!canComplete) return;
		hasShownInitialLoadingTransition = true;
	}, [canComplete, showInitialLoader]);

	const showTopLoadingBar = initialLoadComplete && (!ready || pendingLoads > 0);

	return (
		<PageLoadingContext.Provider value={loadingContext}>
			<div className="relative min-h-dvh bg-[#f6f8fc]">
				{showTopLoadingBar && <RouteLoadingBar />}
				{ready && (
					<div
						className={`min-h-dvh transition-opacity duration-300 ${contentVisible ? "opacity-100" : "opacity-0"}`}
					>
						{children}
					</div>
				)}
				<div
					aria-label={t("nav.loading")}
					aria-live="polite"
					className={`fixed inset-0 z-[100] flex items-center justify-center bg-[#f6f8fc] transition-opacity duration-300 ${
						loaderVisible ? "opacity-100" : "pointer-events-none opacity-0"
					}`}
				>
					<div className="flex w-64 flex-col items-center gap-6">
						<img
							src={iconUrl}
						onError={() => setFailedIcon(branding.iconUrl)}
							alt={`${branding.appName} icon`}
							className="h-20 w-20 rounded-2xl object-contain"
						/>
						<div className="w-full">
							<div className="h-1.5 overflow-hidden rounded-full bg-blue-100">
								<div
									className="h-full rounded-full bg-blue-600 transition-[width] duration-200 ease-out"
									style={{ width: `${canComplete ? 100 : progress}%` }}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</PageLoadingContext.Provider>
	);
}
