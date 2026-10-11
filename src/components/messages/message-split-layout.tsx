"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { useSidebar } from "@/components/sidebar-state";
import { useAssistantOpen } from "@/components/agent/assistant-open-state";
import { readColumnWidth, readInitialColumnWidth, saveColumnWidth } from "@/components/column-width-preferences";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { MessageSelectionContext } from "./message-selection-context";
import { MessageFolderPage } from "./message-folder-page";
import { MessageDetailNavigationProvider } from "./message-detail-navigation";
import { MessageListVisibilityContext } from "./message-list-visibility";
import { readInitialMessageListVisible, saveMessageListVisible } from "./message-list-visibility-utils";
import { useReadingLayout } from "./use-reading-layout";
import { useInitialMessagePreview } from "./use-initial-message-preview";
import type { MessageSplitLayoutProps, SelectedMessage } from "./types";

export function MessageSplitLayout({
	children,
	config,
}: MessageSplitLayoutProps) {
	const pathname = usePathname();
	const [selectedMessages, setSelectedMessages] = useState<SelectedMessage[]>([]);
	const [offset, setOffset] = useState(0);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [listWidth, setListWidth] = useState(360);
	const [listHeight, setListHeight] = useState(280);
	const [widthReady, setWidthReady] = useState(false);
	const [containerWidth, setContainerWidth] = useState(0);
	const [containerHeight, setContainerHeight] = useState(0);
	const [manualListVisible, setManualListVisible] = useState(true);
	const [readingLayout] = useReadingLayout();
	const twoColumnReading = readingLayout !== "off";
	const below = readingLayout === "bottom";
	const containerRef = useRef<HTMLDivElement>(null);
	const startWidth = useRef(listWidth);
	const resizedWidth = useRef(listWidth);
	const startHeight = useRef(listHeight);
	const resizedHeight = useRef(listHeight);
	const { t } = useLanguage();
	const { userId, setForcedMinimal } = useSidebar();
	const assistantOpen = useAssistantOpen();
	const listVisible = twoColumnReading && !assistantOpen && manualListVisible;
	const detailPrefix = `${config.hrefPrefix}/`;
	const selectedMessageId = pathname.startsWith(detailPrefix)
		? pathname.slice(detailPrefix.length).split("/")[0]
		: undefined;
	useInitialMessagePreview({ config, readingLayout, selectedMessageId, offset, unreadOnly });
	const renderedListWidth = Math.max(250, Math.min(listWidth, (containerWidth || 1000) - 280));
	const renderedListHeight = Math.max(96, Math.min(listHeight, (containerHeight || 700) - 180));

	useLayoutEffect(() => {
		setListWidth(readInitialColumnWidth("message-list", 360, 250, 1200));
		setListHeight(readInitialColumnWidth("message-list-height", 280, 96, 1000));
		setManualListVisible(readInitialMessageListVisible());
		const frame = requestAnimationFrame(() => setWidthReady(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		if (!userId) return;
		const savedWidth = readColumnWidth(userId, "message-list", readInitialColumnWidth("message-list", 360, 250, 1200), 250, 1200);
		setListWidth(savedWidth);
		saveColumnWidth(userId, "message-list", savedWidth);
		setListHeight(readColumnWidth(userId, "message-list-height", readInitialColumnWidth("message-list-height", 280, 96, 1000), 96, 1000));
	}, [userId]);

	useLayoutEffect(() => {
		if (!selectedMessageId) {
			setForcedMinimal(false);
			return;
		}
		const container = containerRef.current;
		if (!container) return;
		const measure = () => { setContainerWidth(container.clientWidth); setContainerHeight(container.clientHeight); };
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [selectedMessageId, setForcedMinimal]);

	useEffect(() => () => setForcedMinimal(false), [setForcedMinimal]);
	useEffect(() => { if (below || !twoColumnReading) setForcedMinimal(false); }, [below, twoColumnReading, setForcedMinimal]);

	const selection = { selectedMessages, setSelectedMessages, offset, setOffset, unreadOnly, setUnreadOnly };
	if (!selectedMessageId) return <MessageSelectionContext.Provider value={selection}>{children}</MessageSelectionContext.Provider>;

	return (
		<MessageSelectionContext.Provider value={selection}>
		<div ref={containerRef} data-reading-layout={readingLayout} className="h-full min-h-0 overflow-hidden lg:grid lg:transition-[grid-template-columns,grid-template-rows] lg:ease-in-out motion-reduce:transition-none" style={{ gridTemplateColumns: twoColumnReading && !below ? `${listVisible ? renderedListWidth : 0}px minmax(0,1fr)` : "minmax(0,1fr)", gridTemplateRows: twoColumnReading && below ? `${listVisible ? renderedListHeight : 0}px minmax(0,1fr)` : "minmax(0,1fr)", transitionDuration: widthReady ? "300ms" : "0ms" }}>
			{twoColumnReading && (
			<aside className={`relative hidden min-h-0 min-w-0 overflow-hidden bg-white lg:block ${listVisible ? below ? "border-b border-neutral-200" : "border-r border-neutral-200" : "pointer-events-none"}`} aria-hidden={!listVisible} inert={!listVisible}>
				<div className="h-full min-w-0 overflow-hidden" style={{ width: below ? "100%" : renderedListWidth }}>
				<MessageFolderPage
					config={config}
					compact={!below}
					selectedMessageId={selectedMessageId}
					selection={selection}
				/>
				</div>
				<ResizeHandle
					label={t(below ? "list.resizeHeight" : "list.resize")}
					orientation={below ? "horizontal" : "vertical"}
					onResizeStart={() => { startWidth.current = renderedListWidth; resizedWidth.current = renderedListWidth; startHeight.current = renderedListHeight; resizedHeight.current = renderedListHeight; }}
					onResize={(delta) => {
						if (below) {
							resizedHeight.current = Math.max(96, Math.min(startHeight.current + delta, (containerRef.current?.clientHeight ?? 700) - 180));
							setListHeight(resizedHeight.current);
							return;
						}
						const requestedWidth = startWidth.current + delta;
						setForcedMinimal(requestedWidth < 250);
						resizedWidth.current = Math.max(250, Math.min(requestedWidth, Math.max(250, (containerRef.current?.clientWidth ?? 1000) - 280)));
						setListWidth(resizedWidth.current);
					}}
					onResizeEnd={() => saveColumnWidth(userId, below ? "message-list-height" : "message-list", below ? resizedHeight.current : resizedWidth.current)}
				/>
			</aside>
			)}
			<MessageListVisibilityContext.Provider value={{ visible: listVisible, toggle: () => { const visible = !manualListVisible; setManualListVisible(visible); saveMessageListVisible(visible); }, singleColumn: !twoColumnReading, backHref: config.hrefPrefix, backLabel: config.titleKey ? t(config.titleKey) : config.title }}>
			<MessageDetailNavigationProvider config={config}>
			<section className="min-h-0 min-w-0 overflow-hidden bg-white flex flex-col h-full">
				{children}
			</section>
			</MessageDetailNavigationProvider>
			</MessageListVisibilityContext.Provider>
		</div>
		</MessageSelectionContext.Provider>
	);
}
