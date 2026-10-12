"use client";

import { useEffect, useRef, useState } from "react";

export const PULL_REFRESH_THRESHOLD = 56;

/** Native touch listeners keep iOS scrolling and horizontal row swipes independent. */
export function usePullToRefresh({ enabled, busy, onRefresh }: { enabled: boolean; busy: boolean; onRefresh: () => Promise<void> }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [distance, setDistance] = useState(0);
	const [refreshing, setRefreshing] = useState(false);
	const refreshingRef = useRef(false);
	const latest = useRef({ busy, onRefresh });
	useEffect(() => { latest.current = { busy, onRefresh }; }, [busy, onRefresh]);
	useEffect(() => {
		const element = scrollRef.current;
		if (!enabled || !element) return;
		let start: { x: number; y: number; active: boolean } | null = null;
		let pulled = 0;
		let frame = 0;
		let disposed = false;
		const display = (value: number) => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => { if (!disposed) setDistance(value); });
		};
		const cancel = () => { start = null; pulled = 0; if (!refreshingRef.current) display(0); };
		const onStart = (event: TouchEvent) => {
			if (event.touches.length !== 1) { cancel(); return; }
			if (refreshingRef.current || latest.current.busy || element.scrollTop > 0) return;
			if ((event.target as Element)?.closest?.('button,input,select,textarea,[contenteditable="true"]')) return;
			const touch = event.touches[0];
			start = { x: touch.clientX, y: touch.clientY, active: false };
		};
		const onMove = (event: TouchEvent) => {
			if (!start) return;
			if (event.touches.length !== 1 || element.scrollTop > 0 || latest.current.busy) { cancel(); return; }
			const dx = Math.abs(event.touches[0].clientX - start.x);
			const dy = event.touches[0].clientY - start.y;
			if (!start.active) {
				if (dx > 10 && dx > Math.abs(dy) || dy < -10) { cancel(); return; }
				if (dy < 10 || dy <= dx * 1.25) return;
				start.active = true;
			}
			if (event.cancelable) event.preventDefault();
			pulled = Math.min(96, Math.max(0, dy * 0.55));
			display(pulled);
		};
		const onEnd = (event: TouchEvent) => {
			const trigger = event.touches.length === 0 && start?.active && pulled >= PULL_REFRESH_THRESHOLD;
			cancel();
			if (!trigger || refreshingRef.current || latest.current.busy) return;
			refreshingRef.current = true;
			setRefreshing(true);
			display(48);
			void latest.current.onRefresh().catch(() => undefined).finally(() => {
				refreshingRef.current = false;
				setRefreshing(false);
				if (!disposed) display(0);
				else setDistance(0);
			});
		};
		display(refreshingRef.current ? 48 : 0);
		element.addEventListener("touchstart", onStart, { passive: true });
		element.addEventListener("touchmove", onMove, { passive: false });
		element.addEventListener("touchend", onEnd, { passive: true });
		element.addEventListener("touchcancel", cancel, { passive: true });
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			element.removeEventListener("touchstart", onStart);
			element.removeEventListener("touchmove", onMove);
			element.removeEventListener("touchend", onEnd);
			element.removeEventListener("touchcancel", cancel);
		};
	}, [enabled]);
	return { scrollRef, distance: enabled ? distance : 0, refreshing, ready: distance >= PULL_REFRESH_THRESHOLD };
}
