"use client";
import { isPrimaryInboxMail } from "@/lib/mail-sorting/categories";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { Archive, Check, ChevronLeft, ChevronRight, ListFilter, LoaderCircle, Mail, MailOpen, Paperclip, Star, Trash2, X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { usePageLoading } from "@/components/page-loading";
import { formatScheduledSendTime } from "./scheduled-send-utils";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useMessages } from "@/hooks/use-messages";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { Message } from "@/hooks/types";
import { setMessageDragData } from "@/lib/messages/drag-utils";
import { BulkMessageToolbar } from "./bulk-message-toolbar";
import { SwipeableRow } from "./swipeable-row";
import { MessageListRowActions } from "./message-list-row-actions";
import { MessageLabelChips } from "./message-label-chips";
import { SenderAvatar } from "./sender-avatar";
import { InboxCategoryTabs } from "./inbox-category-tabs";
import { MessageRefreshButton } from "./message-refresh-button";
import { useMessageSelection } from "./message-selection-context";
import { useReadAllTask, prepareBulkScopeSelection, startBulkScopeTask, retryReadAllTask, dismissReadAllTask } from "./read-all-task";
import { PullRefreshList } from "./pull-refresh-list";
import { MessageListEmpty } from "./message-list-empty";
import type { BulkScopeSelection, OrganizationChanges } from "./read-all-task";
import { useReadingLayout } from "./use-reading-layout";
import { dispatchMessageCountsDelta, toggleMessageStar } from "./message-list-row-actions-utils";
import { MessageNavigationProgress, useMessageNavigation } from "./message-navigation";
import { useConversationView } from "./use-conversation-view";
import { useOptimisticArchive } from "./use-optimistic-archive";
import type { MessageFolderPageProps, MessageListRowProps, RowMessageAction, SelectedMessage } from "./types";
import {
	formatMessageListTimestamp,
	getPageRange,
	getMessageParty,
	getMessagePartyClassName,
	getMessagePreview,
	isMessageListRowUnread,
	formatEmailPageTitle,
	getMailboxAddress,
	runBulkMessageAction,
} from "./utils";
import {
	getEmptyFolderConfirmText,
	getEmptyFolderLabel,
	getPermanentDeleteFolderLabel,
	getPermanentDeleteConfirmText,
	supportsPermanentDelete,
} from "@/lib/messages/permanent-delete-utils";
import clsx from "clsx";

const pageSize = 25;

function MessageListRow({
	message,
	config,
	selected,
	active = false,
	compact = false,
	currentAccountName,
	onSelectedChange,
	onMessageAction,
	dragMessageIds,
	canDrag = true,
}: MessageListRowProps) {
	const { t } = useLanguage();
	const Icon = config.icon;
	const [read, setRead] = useState(message.read);
	const [threadUnread, setThreadUnread] = useState(message.threadUnread);
	const [starred, setStarred] = useState(message.starred);
	useEffect(() => setRead(message.read), [message.read]);
	useEffect(() => setThreadUnread(message.threadUnread), [message.threadUnread]);
	useEffect(() => setStarred(message.starred), [message.starred]);
	const rowMessage = { ...message, read, starred, threadUnread };
	const unread = isMessageListRowUnread(rowMessage);
	const draggable = canDrag && message.direction === "inbound" && config.folder !== "drafts" && config.folder !== "scheduled";
	const party = getMessageParty(rowMessage, config.folder, currentAccountName, t);
	const preview = getMessagePreview(rowMessage, config.folder, t);
	const href = `${config.hrefPrefix}/${message.id}`;
	// Stretch the native link across padding and grid gaps; independent controls sit above it.
	const rowLinkClassName = "after:absolute after:inset-0 after:z-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-blue-500";
	const desktopRowLinkClassName = clsx("grid h-full min-w-0 grid-cols-[32px_minmax(160px,190px)_minmax(0,1fr)_auto] items-center gap-2", rowLinkClassName);
	const navigation = useMessageNavigation(href, rowMessage);
	const outbound = message.direction === "outbound";
 const attachmentCount = message.attachmentCount ?? 0;
 const attachmentLabel = attachmentCount > 0 ? t("thread.attachmentCount", {count:attachmentCount}) : "";
 const attachmentIndicator = attachmentCount > 0 ? <span role="img" aria-label={attachmentLabel} title={attachmentLabel} className="inline-flex shrink-0 items-center text-neutral-500"><Paperclip aria-hidden="true" className="h-3.5 w-3.5" /></span> : null;
	const avatar = <SenderAvatar mailboxId={message.mailboxId} address={outbound ? message.toAddr : message.fromAddr} name={party} hasAvatar={outbound ? message.toContactHasAvatar : message.fromContactHasAvatar} className={compact ? "h-10 w-10 text-lg" : "h-6 w-6 text-xs"} />;

	async function runRowAction(action: RowMessageAction) {
		const previousRead = read;
		const previousThreadUnread = threadUnread;
		const unreadDelta = isPrimaryInboxMail(rowMessage) && (message.threadMessageIds?.length??1)===1 ? action === "read" && !read ? -1 : action === "unread" && read ? 1 : 0 : 0;
		if (action === "read") setRead(true);
		if (action === "unread") setRead(false);
		// Grouped rows derive their unread styling from the thread count, so it must change with the row.
		if (message.threadMessageIds) {
			if (action === "read") setThreadUnread(0);
			if (action === "unread") setThreadUnread(message.threadMessageIds.length);
		}
		if (unreadDelta) dispatchMessageCountsDelta({ mailboxId: message.mailboxId, inboxUnreadDelta: unreadDelta });
		try {
			await onMessageAction(message.id, action);
		} catch (error) {
			if (action === "read" || action === "unread") {
				setRead(previousRead);
				setThreadUnread(previousThreadUnread);
				if (unreadDelta) dispatchMessageCountsDelta({ mailboxId: message.mailboxId, inboxUnreadDelta: -unreadDelta });
			}
			throw error;
		}
	}

	const swipeable = compact && (config.folder === "inbox" || config.folder === "snoozed") && message.direction === "inbound";

	function onMessageNavigate(event: MouseEvent<HTMLAnchorElement>) {
		if (!read && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
			const previousThreadUnread = threadUnread;
			setRead(true);
			if (previousThreadUnread !== undefined) setThreadUnread(Math.max(0, previousThreadUnread - 1));
			if (isPrimaryInboxMail(message)) dispatchMessageCountsDelta({ mailboxId: message.mailboxId, inboxUnreadDelta: -1 });
			void runBulkMessageAction([message.id], "read", false).catch(() => {
				setRead(false);
				setThreadUnread(previousThreadUnread);
				if (isPrimaryInboxMail(message)) dispatchMessageCountsDelta({ mailboxId: message.mailboxId, inboxUnreadDelta: 1 });
			});
		}
		navigation.onNavigate(event, !read);
	}

	if (compact) {
		const compactRow = (
			<div
				data-message-row={message.id}
				className={`mail-mobile-row group relative grid grid-cols-[44px_minmax(0,1fr)] gap-2 border-l-2 px-3 py-2.5 transition-colors ${active
					? "border-l-blue-600 bg-blue-50"
					: selected
						? "border-l-transparent bg-blue-50"
						: "border-l-transparent md:hover:bg-neutral-50"
					} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
				data-selected={selected || active}
				draggable={draggable}
				onDragStart={(event) => {
					if (!draggable) return;
					setMessageDragData(event.dataTransfer, { messageIds: dragMessageIds });
				}}
			>
				<MessageNavigationProgress progress={navigation.progress} />
				<label className="relative z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full">
					<input type="checkbox" checked={selected} onChange={event => onSelectedChange(message.id, event.target.checked)} className="peer sr-only" aria-label={t("list.selectFrom", { sender: party })} />
					<span className="rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500">{selected ? <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white"><Check className="h-5 w-5" /></span> : avatar}</span>
				</label>
				<Link href={href} prefetch={false} onPointerEnter={navigation.onHover} onPointerLeave={navigation.onLeave} onFocus={navigation.onIntent} onTouchStart={navigation.onIntent} onClick={config.folder === "drafts" ? undefined : onMessageNavigate} className={clsx("min-w-0", rowLinkClassName)}>
					<span className="flex items-baseline justify-between gap-2 text-sm leading-5">
						<span className={clsx(unread && "font-semibold",getMessagePartyClassName(rowMessage, config.folder))}>
							{party}

							{(message.threadCount ?? 1) > 1 && (
								<span className="ml-2 text-xs font-normal text-neutral-500">{message.threadCount}</span>
							)}
						</span>
						<span className={clsx(unread ?"font-medium":"text-neutral-400","shrink-0 text-[11px]")}>
							{message.scheduledAt ? formatScheduledSendTime(message.scheduledAt, t) : formatMessageListTimestamp(message.createdAt)}
						</span>
					</span>
					<span
						className={`mt-0.5 flex min-w-0 items-center gap-1.5 pr-10 text-sm leading-5 ${unread ? "font-semibold text-neutral-900" : "text-neutral-700"
							}`}
					>
						<span className="min-w-0 truncate">{message.subject ?? t("list.noSubject")}</span>
						{attachmentIndicator}
					</span>
					<span className="mt-0.5 flex min-w-0 items-center justify-between gap-2 pr-10 text-[13px] leading-5 text-neutral-600">
						<span className="min-w-0 flex-1 truncate">{preview}</span>
						<MessageLabelChips labels={message.labels} compact />
					</span>
				</Link>
				{config.folder !== "drafts" && <button type="button" data-mobile-star aria-label={starred ? t("list.starred") : t("list.notStarred")} aria-pressed={starred} className="absolute bottom-0 right-1 z-10 flex h-11 w-11 items-center justify-center rounded-full hover:bg-neutral-100" onClick={() => { void toggleMessageStar(message.id).then(result => setStarred(result.starred)).catch(() => undefined); }}><Star className={clsx("h-5 w-5", starred ? "fill-amber-400 text-amber-400" : "text-neutral-400")} /></button>}
			</div>
		);
		if (!swipeable) return compactRow;
		return (
			<SwipeableRow
				startAction={{
					label: read ? t("list.markUnread") : t("list.markRead"),
					icon: read ? Mail : MailOpen,
					className: "bg-blue-600",
					onTrigger: () => void runRowAction(read ? "unread" : "read").catch(() => undefined),
				}}
				endAction={{
					label: t("common.archive"),
					icon: Archive,
					className: "bg-emerald-600",
					onTrigger: () => void runRowAction("archive").catch(() => undefined),
				}}
			>
				{compactRow}
			</SwipeableRow>
		);
	}

	const className =
		`group relative grid min-h-10 w-full grid-cols-[24px_minmax(0,1fr)] items-center gap-2 px-4 text-left text-sm hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm ${active || selected ? "bg-blue-50" : ""
		} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`;
	const content = (
		<>
			{config.folder === "inbox" && message.direction === "inbound" && (
				<Tooltip className="relative z-10" label={starred ? t("list.starred") : t("list.notStarred")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void toggleMessageStar(message.id).then((result) => setStarred(result.starred));
						}}
						aria-label={starred ? t("list.starred") : t("list.notStarred")}
					>
						<Icon className={`h-4 w-4 ${starred ? "fill-amber-400 text-amber-400" : "text-neutral-300"}`} />
					</Button>
				</Tooltip>
			)}
			{(config.folder !== "inbox" || message.direction !== "inbound") && (
				<Icon className="h-4 w-4 text-neutral-300" />
			)}
			<span className="flex min-w-0 items-center gap-2">
				{avatar}
				<span className={clsx(unread && "font-semibold", getMessagePartyClassName(rowMessage, config.folder))}>{party}</span>

				{(message.threadCount ?? 1) > 1 && (
					<span className="ml-2 text-xs text-neutral-500">{message.threadCount}</span>
				)}
			</span>
			<span className="flex min-w-0 items-center gap-2 text-neutral-700">
				<MessageLabelChips labels={rowMessage.labels} />
				<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
					<span title={rowMessage.subject ?? t("list.noSubject")} className={clsx("min-w-0 max-w-[65%] truncate", unread && "font-semibold text-neutral-900")}>{rowMessage.subject ?? t("list.noSubject")}</span>
					<span aria-hidden="true" className="shrink-0 text-neutral-400">–</span>
					<span title={getMessagePreview(rowMessage, config.folder, t)} className="min-w-0 flex-1 truncate text-neutral-600">{getMessagePreview(rowMessage, config.folder, t)}</span>
				</span>
				{attachmentIndicator}
			</span>
			<time
				dateTime={message.createdAt}
				className={`min-w-[96px] whitespace-nowrap text-right text-xs group-hover:opacity-0 ${unread ? "font-semibold text-neutral-800" : "text-neutral-500"
					}`}
			>
				{message.scheduledAt ? formatScheduledSendTime(message.scheduledAt, t) : formatMessageListTimestamp(message.createdAt)}
			</time>
		</>
	);

	if (config.folder === "drafts") {
		return (
			<div className={className} data-message-row={message.id}>
				<Checkbox
					checked={selected}
					onChange={(event) => onSelectedChange(message.id, event.target.checked)}
					className="relative z-10 h-4 w-4 rounded border-neutral-300"
					aria-label={t("list.selectMessage")}
				/>
				<Link href={href} prefetch={false} className={desktopRowLinkClassName}>
					{content}
				</Link>
			</div>
		);
	}

	return (
		<div
			data-message-row={message.id}
			className={className}
			draggable={draggable}
			onDragStart={(event) => {
				if (!draggable) return;
				setMessageDragData(event.dataTransfer, { messageIds: dragMessageIds });
			}}
		>
			<MessageNavigationProgress progress={navigation.progress} />
			<Checkbox
				checked={selected}
				onChange={(event) => onSelectedChange(message.id, event.target.checked)}
				className="relative z-10 h-4 w-4 rounded border-neutral-300"
				aria-label={t("list.selectMessage")}
			/>
			<Link href={href} prefetch={false} onPointerEnter={navigation.onHover} onPointerLeave={navigation.onLeave} onFocus={navigation.onIntent} onTouchStart={navigation.onIntent} onClick={onMessageNavigate} className={desktopRowLinkClassName}>
				{content}
			</Link>
			{(config.folder === "inbox" || config.folder === "snoozed") && message.direction === "inbound" && (
				<MessageListRowActions
					message={rowMessage}
					onAction={runRowAction}
				/>
			)}
		</div>
	);
}

export function MessageFolderPage({
	config,
	compact = false,
	selectedMessageId,
	selection,
}: MessageFolderPageProps) {
	const { t, locale } = useLanguage();
	const readAllTask = useReadAllTask();
	const router = useRouter();
	const currentReader = useRef({ prefix: config.hrefPrefix, id: selectedMessageId });
	useEffect(() => { currentReader.current = { prefix: config.hrefPrefix, id: selectedMessageId }; }, [config.hrefPrefix, selectedMessageId]);
	const [readingLayout] = useReadingLayout();
	const sharedSelection = useMessageSelection();
	selection ??= sharedSelection ?? undefined;
	const title = config.titleKey ? t(config.titleKey) : config.title;
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { query } = useMailSearch();
	const isMobile = useIsMobile();
	const [internalOffset, setInternalOffset] = useState(0);
	const offset = selection?.offset ?? internalOffset;
	const setOffset = selection?.setOffset ?? setInternalOffset;
	const [internalSelectedMessages, setInternalSelectedMessages] = useState<
		SelectedMessage[]
	>([]);
	const [pendingBulkAction, setPendingBulkAction] = useState(false);
	const [allSelection, setAllSelection] = useState<(BulkScopeSelection & { key: string }) | null>(null);
	const [selectionError, setSelectionError] = useState(false);
	const [emptyingFolder, setEmptyingFolder] = useState(false);
	const [internalUnreadOnly, setInternalUnreadOnly] = useState(false);
	const unreadOnly = selection?.unreadOnly ?? internalUnreadOnly;
	const setUnreadOnly = selection?.setUnreadOnly ?? setInternalUnreadOnly;
	const [conversationView] = useConversationView();
	const grouped = conversationView && config.folder !== "drafts";
	const { messages: sourceMessages, isLoading: messagesLoading, isRefreshing, error, total: sourceTotal, limit, updateMessages, refresh } = useMessages(config.folder, selectedMailbox?.id, {
		query,
		limit: pageSize,
		offset,
		read: unreadOnly ? "unread" : "all",
		group: grouped ? "thread" : undefined,
	}, !mailboxesLoading, config.folderId);
	const { messages, total, archiveRow, archiveFailed } = useOptimisticArchive(sourceMessages, sourceTotal,
		JSON.stringify([query, selectedMailbox?.id, config.folder, config.folderId, unreadOnly, grouped, offset]));
	const isLoading = mailboxesLoading || messagesLoading;
	const { counts } = useMessageCounts(selectedMailbox?.id, !mailboxesLoading);
	usePageLoading(isLoading);
	const headerIcons = config.headerIcons ?? [];
	const hasActiveFilters = !!query.trim();
	const folderCount = config.folderId
		? counts.customFolders[config.folderId]
		: counts.folders[config.folder];
	const titleTotal = folderCount?.total ?? total;
	const titleUnread = folderCount?.unread ?? 0;
	const mailboxAddress = getMailboxAddress(selectedMailbox);
	const currentAccountName = selectedMailbox?.displayName ?? selectedMailbox?.localPart;
	const pageRange = getPageRange(offset, messages.length, total);
	const hasCategoryTabs = !config.folderId && ["inbox", "promotions", "social", "invoices", "orders"].includes(config.folder);
	const selectedMessages = selection?.selectedMessages ?? internalSelectedMessages;
	const setSelectedMessages =
		selection?.setSelectedMessages ?? setInternalSelectedMessages;
	const selectedIds = useMemo(
		() => selectedMessages.map((message) => message.id),
		[selectedMessages],
	);
	// Opening a row targets it without changing the explicit checkbox selection.
	// Only use a row in the current result, so navigation cannot act on stale mail.
	const activeMessage = messages.find((message) => message.id === selectedMessageId);
	const usingActiveMessage = selectedIds.length === 0 && !!activeMessage;
	const actionIds = usingActiveMessage ? [activeMessage.id] : selectedIds;
	const hasUnreadSelection = usingActiveMessage
		? !activeMessage.read || (activeMessage.threadUnread ?? 0) > 0
		: selectedMessages.some((message) => !message.read);
	const selectionMailboxIds = usingActiveMessage ? [activeMessage.mailboxId] : [...new Set(selectedMessages.map(message => message.mailboxId ?? messages.find(row => row.id === message.id)?.mailboxId))];
	const selectionMailboxId = selectionMailboxIds.length === 1 ? selectionMailboxIds[0] ?? undefined : undefined;
	const allVisibleSelected = messages.length > 0 && messages.every((message) => selectedIds.includes(message.id));
	// In conversation view a row stands for every message of its thread in this
	// folder, so actions and drags carry all of them.
	const rowMessageIds = (message: Message) => message.threadMessageIds ?? [message.id];
	const expandSelectedIds = (ids: string[]) =>
		ids.flatMap((id) => selectedMessages.find(message => message.id === id)?.messageIds ?? rowMessageIds(messages.find((message) => message.id === id) ?? { id } as Message));

	const selectionScope = JSON.stringify([query, selectedMailbox?.id, config.folder, config.folderId, unreadOnly, grouped]);
	const allMatchingSelected = allSelection?.key === selectionScope && selectedIds.length > 0;
	const previousScope = useRef(selectionScope);
	const previousOffset = useRef(offset);
	useEffect(() => {
		if (previousScope.current === selectionScope) return;
		previousScope.current = selectionScope;
		setAllSelection(null);
		setSelectionError(false);
		setOffset(0);
		setSelectedMessages([]);
	}, [selectionScope, setSelectedMessages, setOffset]);

	useEffect(() => {
		if (previousOffset.current === offset) return;
		previousOffset.current = offset;
		setAllSelection(null);
		setSelectedMessages([]);
	}, [offset, setSelectedMessages]);

	useEffect(() => {
		if (mailboxesLoading) return;
		document.title = formatEmailPageTitle({
			location: title,
			inbox: config.folder === "inbox" && !config.folderId,
			total: titleTotal,
			unread: titleUnread,
			emailAddress: mailboxAddress,
		});
	}, [title, config.folder, config.folderId, mailboxAddress, mailboxesLoading, titleTotal, titleUnread]);

	function updateSelectedMessage(messageId: string, selected: boolean) {
		setAllSelection(null);
		const message = messages.find((item) => item.id === messageId);
		if (!message) return;

		setSelectedMessages((current) => {
			if (!selected) return current.filter((item) => item.id !== messageId);
			if (current.some((item) => item.id === messageId)) return current;
			return [...current, { id: message.id, read: message.read && !(message.threadUnread ?? 0), messageIds: rowMessageIds(message), mailboxId: message.mailboxId }];
		});
		// Match the split layout's desktop breakpoint; on phones (including
		// landscape) checkboxes must leave the list available for multi-selection.
		if (selected && window.matchMedia("(min-width: 1024px)").matches && readingLayout !== "off" && message.id !== selectedMessageId && config.folder !== "drafts") router.push(`${config.hrefPrefix}/${message.id}`);
	}

	function toggleAllVisible(selected: boolean) {
		setAllSelection(null);
		const visibleIds = new Set(messages.map((message) => message.id));
		setSelectedMessages((current) => {
			if (!selected) {
				return current.filter((message) => !visibleIds.has(message.id));
			}

			const next = new Map(current.map((message) => [message.id, message]));
			for (const message of messages) {
				next.set(message.id, { id: message.id, read: message.read && !(message.threadUnread ?? 0), messageIds: rowMessageIds(message), mailboxId: message.mailboxId });
			}
			return Array.from(next.values());
		});
		const last = messages.at(-1);
		if (selected && last && window.matchMedia("(min-width: 1024px)").matches && readingLayout !== "off" && config.folder !== "drafts") router.push(`${config.hrefPrefix}/${last.id}`);
	}

	const permanentDeleteFolder = !config.folderId && supportsPermanentDelete(config.folder) ? config.folder : null;
	async function runRowMessageAction(messageId: string, action: RowMessageAction) {
		if (action !== "archive") return runBulkMessageAction(expandSelectedIds([messageId]), action, action !== "read" && action !== "unread");
		const message = messages.find(row => row.id === messageId);
		if (!message) return;
		try {
			await archiveRow(message);
			setSelectedMessages(current => current.filter(row => row.id !== messageId));
		} catch {
			// The optimistic archive restores this row and exposes an inline error.
		}
	}
	async function emptyFolder() {
		if (!permanentDeleteFolder || !selectedMailbox?.id || readAllTask?.status === "running") return;
		if (!window.confirm(getEmptyFolderConfirmText(permanentDeleteFolder, titleTotal, t))) return;
		setEmptyingFolder(true);
		try {
			const scope = { folder: permanentDeleteFolder, mailboxId: selectedMailbox.id, query: "", unreadOnly: false, title };
			const selection = await prepareBulkScopeSelection(scope);
			startBulkScopeTask(scope, selection, "delete");
			setOffset(0);
		} catch (error) {
			console.error(error);
			window.alert(t("list.emptyFailed", { folder: getPermanentDeleteFolderLabel(permanentDeleteFolder, t) }));
		} finally {
			setEmptyingFolder(false);
		}
	}

	function clearSelection() { setAllSelection(null); setSelectedMessages([]); }
	const currentBulkScope = () => ({ folder: config.folder, mailboxId: selectedMailbox?.id, folderId: config.folderId, query, unreadOnly, title });
	async function selectAllMatching() {
		const key = selectionScope;
		setPendingBulkAction(true); setSelectionError(false);
		try {
			const prepared = await prepareBulkScopeSelection(currentBulkScope());
			if (previousScope.current === key) setAllSelection({ ...prepared, key });
		} catch { if (previousScope.current === key) setSelectionError(true); }
		finally { setPendingBulkAction(false); }
	}
	function organizeAll(changes: OrganizationChanges) {
		if (!allMatchingSelected || !allSelection) return;
		startBulkScopeTask(currentBulkScope(), allSelection, "organize", undefined, changes);
		clearSelection();
	}
	async function runSelectedAction(action: BulkMessageAction, folderId?: string) {
		if (allMatchingSelected && allSelection) {
			if (action === "delete" && !window.confirm(getPermanentDeleteConfirmText(allSelection.total, t))) return;
			if (action === "trash" && !window.confirm(t("list.confirmAllTrash", { count: allSelection.total.toLocaleString(locale), folder: title }))) return;
			startBulkScopeTask(currentBulkScope(), allSelection, action, folderId);
			clearSelection();
			if (["trash", "archive", "spam", "delete", "inbox", "folder"].includes(action) && selectedMessageId) router.replace(config.hrefPrefix);
			return;
		}
		if (actionIds.length === 0) return;
		if (action === "delete") {
			const ids = expandSelectedIds(actionIds);
			if (!window.confirm(getPermanentDeleteConfirmText(ids.length, t))) return;
		}

		setPendingBulkAction(true);
		const previousMessages = messages;
		const readValue = action === "read" ? true : action === "unread" ? false : null;
		const changedMessages = readValue === null
			? []
			: messages.filter((message) => actionIds.includes(message.id) && message.read !== readValue);
		if (readValue !== null) {
			updateMessages((current) => current.map((message) =>
				actionIds.includes(message.id) ? { ...message, read: readValue, ...(message.threadMessageIds ? { threadUnread: readValue ? 0 : message.threadMessageIds.length } : {}) } : message,
			));
			setSelectedMessages((current) => current.map((message) => ({ ...message, read: readValue })));
			const inboxUnreadDelta = changedMessages
				.filter((message) => isPrimaryInboxMail(message) && (message.threadMessageIds?.length??1)===1)
				.reduce((total, message) => total + (readValue ? (message.read ? 0 : -1) : (message.read ? 1 : 0)), 0);
			if (inboxUnreadDelta) dispatchMessageCountsDelta({ mailboxId: selectedMailbox?.id, inboxUnreadDelta });
		}
		try {
			await runBulkMessageAction(expandSelectedIds(actionIds), action, true, folderId);
			setSelectedMessages([]);
			if (currentReader.current.prefix === config.hrefPrefix && currentReader.current.id === selectedMessageId && actionIds.includes(selectedMessageId ?? "") && ["trash", "archive", "spam", "delete", "inbox", "folder"].includes(action)) router.replace(config.hrefPrefix);
		} catch (error) {
			if (readValue !== null) {
				updateMessages(previousMessages);
				const inboxUnreadDelta = changedMessages
					.filter((message) => isPrimaryInboxMail(message) && (message.threadMessageIds?.length??1)===1)
					.reduce((total, message) => total + (readValue ? (message.read ? 0 : 1) : (message.read ? -1 : 0)), 0);
				if (inboxUnreadDelta) dispatchMessageCountsDelta({ mailboxId: selectedMailbox?.id, inboxUnreadDelta });
			}
			throw error;
		} finally {
			setPendingBulkAction(false);
		}
	}

	return (
		<div className="mail-mobile-list flex h-full min-h-0 flex-col">
			<div className={`mail-mobile-list-toolbar flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 ${compact ? "px-4" : "px-4.5 md:px-6"}`}>
				<div className="flex min-w-0 flex-1 items-center gap-3 max-md:gap-1">
					<Tooltip label={t("list.selectAll")} className="shrink-0">
						<Checkbox
							checked={allMatchingSelected || allVisibleSelected}
							disabled={messages.length === 0 || pendingBulkAction}
							onChange={(event) => toggleAllVisible(event.target.checked)}
							className="h-4 w-4 rounded border-neutral-300"
							aria-label={t("list.selectAll")}
						/>
					</Tooltip>
					{!hasCategoryTabs && <MessageRefreshButton onRefresh={refresh} refreshing={isRefreshing} disabled={isLoading || pendingBulkAction} />}
					{actionIds.length > 0 || (!compact && !isMobile) ? (
						<BulkMessageToolbar
							messageIds={expandSelectedIds(actionIds)}
							mailboxId={selectionMailboxId}
							selectedCount={allMatchingSelected ? allSelection!.total : actionIds.length}
							hasUnreadSelection={allMatchingSelected ? allSelection!.unread > 0 : hasUnreadSelection}
							hideSelectedCount={usingActiveMessage || allMatchingSelected || allVisibleSelected}
							hideClearSelection={usingActiveMessage}
							onAction={runSelectedAction}
							onClearSelection={clearSelection}
							onOrganizeAll={allMatchingSelected ? organizeAll : undefined}
							allCanManage={allMatchingSelected ? allSelection?.canManage : undefined}
							organizeDisabled={allMatchingSelected && allSelection?.mailboxIds.length !== 1}
							pending={pendingBulkAction || readAllTask?.status === "running" || actionIds.length === 0}
							compact={compact}
							folder={config.folderId ? undefined : config.folder}
						/>
					) : (
						(compact || isMobile) && (
							<h1 className="truncate text-xs font-medium tracking-wide text-neutral-500 pl-1">{title}</h1>
						)
					)}
				</div>
			{selectedIds.length === 0 && (
					<div className="flex shrink-0 items-center gap-1 text-neutral-500 sm:gap-2">
						<Tooltip label={t("list.previousPage")}>
							<Button
								variant="ghost"
								size="sm"
								disabled={offset === 0 || isLoading}
								onClick={() => setOffset(Math.max(offset - limit, 0))}
								aria-label={t("list.previousPage")}
							>
								<ChevronLeft className="h-4 w-4" />
							</Button>
						</Tooltip>
						<span data-message-range aria-live="polite" aria-atomic="true" className="whitespace-nowrap text-[11px] tabular-nums sm:text-xs">
							{t("list.range", { start: pageRange.start, end: pageRange.end, total: pageRange.total })}
						</span>
						<Tooltip label={t("list.nextPage")}>
							<Button
								variant="ghost"
								size="sm"
								disabled={offset + messages.length >= total || isLoading}
								onClick={() => setOffset(offset + limit)}
								aria-label={t("list.nextPage")}
							>
								<ChevronRight className="h-4 w-4" />
							</Button>
						</Tooltip>
						{config.folder === "inbox" && (
							<Tooltip label={unreadOnly ? t("list.showingUnread") : t("list.showUnreadOnly")}>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label={t("list.showUnreadOnly")}
									aria-pressed={unreadOnly}
									onClick={() => setUnreadOnly((current) => !current)}
									className={unreadOnly ? "bg-blue-100 text-blue-700 hover:bg-blue-100" : undefined}
								>
									<ListFilter className="h-4 w-4" />
								</Button>
							</Tooltip>
						)}
						{permanentDeleteFolder && (
							<Tooltip label={getEmptyFolderLabel(permanentDeleteFolder, t)}>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label={getEmptyFolderLabel(permanentDeleteFolder, t)}
									disabled={emptyingFolder || isLoading || total === 0 || readAllTask?.status === "running"}
									onClick={() => void emptyFolder()}
									className="gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
								>
									<Trash2 className="h-4 w-4" />
									{!compact && <span className="max-md:hidden">{emptyingFolder ? t("list.emptying") : getEmptyFolderLabel(permanentDeleteFolder, t)}</span>}
								</Button>
							</Tooltip>
						)}
						{!compact && headerIcons.map((Icon, index) => (
							<Icon key={index} className="h-4 w-4" />
						))}
					</div>
				)}
			</div>
			{(readAllTask || allVisibleSelected || allMatchingSelected) && (
				<div data-folder-read-all className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-neutral-200 bg-neutral-50 px-4 py-1.5 text-xs">
					{readAllTask ? <>
						<span role={readAllTask.status === "failed" ? "alert" : "status"} className="flex min-w-0 flex-1 items-center gap-1.5">
							{readAllTask.status === "running" && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />}
							<span className="truncate" title={readAllTask.error ?? readAllTask.scope.title}>{t(readAllTask.action === "applyRule" && readAllTask.status !== "failed" ? readAllTask.status === "running" ? "rules.applyProgress" : "rules.applyDone" : readAllTask.status === "running" ? readAllTask.id ? "list.bulkServerProgress" : "list.bulkStarting" : readAllTask.status === "failed" ? "list.bulkServerFailed" : "list.bulkScopeDone", { count: (readAllTask.status === "running" || readAllTask.action === "applyRule") && readAllTask.total !== undefined ? `${readAllTask.processed.toLocaleString(locale)} / ${readAllTask.total.toLocaleString(locale)}` : readAllTask.processed.toLocaleString(locale), folder: readAllTask.scope.title })}</span>
						</span>
						{readAllTask.status === "failed" && readAllTask.canRetry !== false && <button type="button" onClick={retryReadAllTask} className="shrink-0 font-medium text-blue-700 hover:underline">{t("list.markAllReadRetry")}</button>}
						{readAllTask.status !== "running" && <button type="button" onClick={dismissReadAllTask} aria-label={t("navigation.close")} className="rounded p-1 hover:bg-neutral-200"><X className="h-3.5 w-3.5" /></button>}
					</> : <>
						<span className="min-w-0 text-neutral-500">{t(allMatchingSelected ? "list.allMatchingSelected" : "list.pageSelectedCompact", { count: (allMatchingSelected ? allSelection!.total : messages.length).toLocaleString(locale) })}</span>
						<button type="button" disabled={pendingBulkAction || isLoading || isRefreshing}
							onClick={allMatchingSelected ? clearSelection : () => void selectAllMatching()}
							className="ml-auto shrink-0 rounded px-1.5 py-1 font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
							{t(allMatchingSelected ? "common.clearSelection" : hasActiveFilters || unreadOnly ? "list.selectAllMatches" : "list.selectAllFolder")}
						</button>
					</>}
				</div>
			)}
			{hasCategoryTabs && <InboxCategoryTabs folder={config.folder} compact={compact} onRefresh={refresh} refreshing={isRefreshing} disabled={isLoading || pendingBulkAction} />}
			{selectionError && <p role="alert" className="shrink-0 px-4 py-2 text-xs text-red-700">{t("list.allSelectionFailed")}</p>}
			{error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-red-700">{t("list.loadFailed")}</p>}
			{archiveFailed && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-red-700">{t("error.updateSelected")}</p>}

			<PullRefreshList enabled={isMobile} busy={isLoading || isRefreshing || pendingBulkAction} onRefresh={refresh} empty={!isLoading && !error && messages.length === 0}>
				{messages.map((message) => (
					<MessageListRow
						key={message.id}
						message={message}
						config={config}
						selected={selectedIds.includes(message.id)}
						active={message.id === selectedMessageId}
						compact={compact || isMobile}
						currentAccountName={currentAccountName}
						onSelectedChange={updateSelectedMessage}
						onMessageAction={runRowMessageAction}
						dragMessageIds={expandSelectedIds(selectedIds.includes(message.id) ? selectedIds : [message.id])}
						canDrag={!selectedMailbox?.permission || selectedMailbox.permission === "full_access"}
					/>
				))}
				{!isLoading && !error && messages.length === 0 && (
					<MessageListEmpty text={hasActiveFilters ? t("list.noMatch") : config.emptyTextKey ? t(config.emptyTextKey) : config.emptyText} />
				)}
			</PullRefreshList>
		</div>
	);
}
