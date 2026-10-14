"use client";

import type { ReactNode } from "react";
import { Check, LoaderCircle } from "lucide-react";
import clsx from "clsx";
import { useLanguage } from "@/components/language-provider";
import { usePullToRefresh } from "./use-pull-to-refresh";

/** Animate only two wrappers; the rows remain stable during the touch gesture. */
export function PullRefreshList({ children, enabled, busy, onRefresh, empty = false }: {
	children: ReactNode; enabled: boolean; busy: boolean; onRefresh: () => Promise<void>; empty?: boolean;
}) {
	const { t } = useLanguage();
	const { scrollRef, distance, refreshing, dragging, ready } = usePullToRefresh({ enabled, busy, onRefresh });
	const transition = dragging ? "none" : "transform 360ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity 220ms ease-out";
	return <div ref={scrollRef} className={clsx("mail-mobile-list-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable", empty && "flex flex-col")}>
		<div data-pull-refresh aria-hidden={distance < 20}
			style={{ transform: `translate3d(0,${distance - 48}px,0)`, opacity: Math.min(1, distance / 20), transition }}
			className="pull-refresh-motion pointer-events-none absolute inset-x-0 top-0 flex h-12 items-center justify-center overflow-hidden text-xs text-neutral-500">
			<div className={clsx("flex items-center gap-2 rounded-full bg-white px-3 py-2 shadow-sm ring-1 ring-neutral-200", ready && !refreshing && "text-blue-600")}>
				{ready && !refreshing ? <Check aria-hidden="true" className="h-4 w-4 shrink-0" /> : <LoaderCircle aria-hidden="true" className={clsx("h-4 w-4 shrink-0", refreshing && "animate-spin motion-reduce:animate-none")} style={!refreshing ? { transform: `rotate(${distance * 3}deg)` } : undefined} />}
				<span role="status">{t(refreshing ? "list.refreshing" : ready ? "list.pullRelease" : "list.pullRefresh")}</span>
			</div>
		</div>
		<div data-pull-content className={clsx("pull-refresh-motion md:divide-y divide-neutral-100", empty && "flex flex-1 items-center justify-center")} style={{ transform: distance ? `translate3d(0,${distance}px,0)` : undefined, transition, willChange: dragging || refreshing ? "transform" : undefined }}>
			{children}
		</div>
	</div>;
}
