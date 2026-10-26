"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "@/hooks/types";
import { MessageOpeningContext } from "./message-opening";
import { MessageOpeningPreview } from "./message-opening-preview";
import { MessageReaderToolbar } from "./message-reader-toolbar";
import { MessageReadingHeaderButton } from "./message-reading-header-button";
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
import type { MessageSplitLayoutProps, SelectedMessage } from "./types";

export function MessageSplitLayout({
	children,
	config,
	renderOverview = false,
}: MessageSplitLayoutProps) {
	const pathname = usePathname();
	const [opening, setOpening] = useState<{ from: string; message: Message; href: string } | null>(null);
	const pendingMessage = opening?.from === pathname ? opening.message : null;
	if (opening && opening.from !== pathname) setOpening(null);
	const [selectedMessages, setSelectedMessages] = useState<SelectedMessage[]>([]);
	const [offset, setOffset] = useState(0);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [selectionScope, setSelectionScope] = useState(config.hrefPrefix);
	if (selectionScope !== config.hrefPrefix) {
		setSelectionScope(config.hrefPrefix);
		setSelectedMessages([]);
		setOffset(0);
		setUnreadOnly(false);
	}
	const [listWidth, setListWidth] = useState(360);
	const [listRatio, setListRatio] = useState(.5);
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
	const startHeight = useRef(0);
	const resizedRatio = useRef(listRatio);
	const { t } = useLanguage();
	const { userId, setForcedMinimal } = useSidebar();
	const assistantOpen = useAssistantOpen();
	const detailPrefix = `${config.hrefPrefix}/`;
	const selectedMessageId = pendingMessage?.id ?? (pathname.startsWith(detailPrefix)
		? pathname.slice(detailPrefix.length).split("/")[0]
		: undefined);
	const isOverview = pathname === config.hrefPrefix || pathname === detailPrefix;
	const rendersPane = !!selectedMessageId || (twoColumnReading && isOverview);
	// The overview must remain reachable even if the list was hidden in a reader.
	const listVisible = twoColumnReading && (!selectedMessageId || (!assistantOpen && manualListVisible));
	const renderedListWidth = Math.max(250, Math.min(listWidth, (containerWidth || 1000) - 280));
	const renderedListHeight = (containerHeight || 700) * listRatio;

	useLayoutEffect(() => {
		setListWidth(readInitialColumnWidth("message-list", 360, 250, 1200));
		setListRatio(readInitialColumnWidth("message-list-ratio", .5, .05, .95));
		setManualListVisible(readInitialMessageListVisible());
		const frame = requestAnimationFrame(() => setWidthReady(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		if (!userId) return;
		const savedWidth = readColumnWidth(userId, "message-list", readInitialColumnWidth("message-list", 360, 250, 1200), 250, 1200);
		setListWidth(savedWidth);
		saveColumnWidth(userId, "message-list", savedWidth);
		setListRatio(readColumnWidth(userId, "message-list-ratio", readInitialColumnWidth("message-list-ratio", .5, .05, .95), .05, .95));
	}, [userId]);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const measure = () => { setContainerWidth(container.clientWidth); setContainerHeight(container.clientHeight); };
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [rendersPane]);

	useEffect(() => () => setForcedMinimal(false), [setForcedMinimal]);
	useEffect(() => { if (below || !twoColumnReading) setForcedMinimal(false); }, [below, twoColumnReading, setForcedMinimal]);

	const selection = { selectedMessages, setSelectedMessages, offset, setOffset, unreadOnly, setUnreadOnly };
	const openingContext = { pendingMessageId: pendingMessage?.id ?? null, open: (message: Message, href: string) => { if (href.startsWith(detailPrefix)) setOpening({ from: pathname, message, href }); }, cancel: () => setOpening(null) };
	if (!rendersPane) return <MessageOpeningContext.Provider value={openingContext}><MessageSelectionContext.Provider value={selection}>{renderOverview && isOverview ? <MessageFolderPage config={config} selection={selection} /> : children}</MessageSelectionContext.Provider></MessageOpeningContext.Provider>;

	return (
		<MessageOpeningContext.Provider value={openingContext}><MessageSelectionContext.Provider value={selection}>
		<div ref={containerRef} data-reading-layout={readingLayout} className="h-full min-h-0 overflow-hidden lg:grid lg:transition-[grid-template-columns,grid-template-rows] lg:ease-in-out motion-reduce:transition-none" style={{ gridTemplateColumns: twoColumnReading && !below ? `${listVisible ? renderedListWidth : 0}px minmax(0,1fr)` : "minmax(0,1fr)", gridTemplateRows: twoColumnReading && below ? listVisible ? `minmax(0,${listRatio}fr) minmax(0,${1 - listRatio}fr)` : "0px minmax(0,1fr)" : "minmax(0,1fr)", transitionDuration: widthReady ? "300ms" : "0ms" }}>
			{twoColumnReading && (
			<aside className={`relative min-h-0 min-w-0 overflow-hidden bg-white lg:block ${selectedMessageId ? "hidden" : "h-full lg:h-auto"} ${listVisible ? below ? "border-b border-neutral-200" : "border-r border-neutral-200" : "pointer-events-none"}`} aria-hidden={!listVisible} inert={!listVisible}>
				<div className="h-full min-w-0 overflow-hidden" style={{ width: below || !selectedMessageId ? "100%" : renderedListWidth }}>
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
					onResizeStart={() => { startWidth.current = renderedListWidth; resizedWidth.current = renderedListWidth; startHeight.current = renderedListHeight; resizedRatio.current = listRatio; }}
					onResize={(delta) => {
						if (below) {
							const height = containerRef.current?.clientHeight || 700;
							resizedRatio.current = Math.max(.05, Math.min(.95, Math.max(96, Math.min(startHeight.current + delta, height - 180)) / height));
							setListRatio(resizedRatio.current);
							return;
						}
						const requestedWidth = startWidth.current + delta;
						setForcedMinimal(requestedWidth < 250);
						resizedWidth.current = Math.max(250, Math.min(requestedWidth, Math.max(250, (containerRef.current?.clientWidth ?? 1000) - 280)));
						setListWidth(resizedWidth.current);
					}}
					onResizeEnd={() => saveColumnWidth(userId, below ? "message-list-ratio" : "message-list", below ? resizedRatio.current : resizedWidth.current)}
				/>
			</aside>
			)}
			<MessageListVisibilityContext.Provider value={{ visible: listVisible, toggle: () => { const visible = !manualListVisible; setManualListVisible(visible); saveMessageListVisible(visible); }, singleColumn: !twoColumnReading, backHref: config.hrefPrefix, backLabel: config.titleKey ? t(config.titleKey) : config.title }}>
			<section data-message-reading-pane aria-label={t("settings.reading.title")} className={`min-h-0 min-w-0 overflow-hidden bg-white flex-col h-full ${selectedMessageId ? "flex" : "hidden lg:flex"}`}>
				{pendingMessage ? <><MessageReaderToolbar><MessageReadingHeaderButton assistantVisible={assistantOpen} /></MessageReaderToolbar><MessageOpeningPreview key={pendingMessage.id} message={pendingMessage} href={opening?.href ?? config.hrefPrefix} /></> : selectedMessageId ? <MessageDetailNavigationProvider config={config} messageId={selectedMessageId}>{children}</MessageDetailNavigationProvider> :
					<div data-empty-reader role="status" className="flex flex-1 justify-center px-6 pt-12 text-sm text-neutral-500">{t("message.noConversationSelected")}</div>}
			</section>
			</MessageListVisibilityContext.Provider>
		</div>
		</MessageSelectionContext.Provider></MessageOpeningContext.Provider>
	);
}
