"use client";

import { createElement, useState, useMemo, useCallback, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import { Archive, Ban, BellOff, Clock, FileCode2, Forward, ListFilter, Mail, MailOpen, MoreVertical, Reply, ReplyAll, ShieldAlert, Trash2 } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MessageActionMenuContent } from "@/components/messages/message-action-menu-content";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "@/components/compose/compose-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useHotkeys, useShortcuts } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageActionsProps, ReplyMode } from "./types";
import { getPermanentDeleteConfirmText, supportsPermanentDelete } from "@/lib/messages/permanent-delete-utils";
import {
	confirmTrashWithoutUnsubscribe,
	blockMessageContact,
	createForwardDraft,
	createReplyDraft,
	createTrashSenderRule,
	getMessageActionRedirect,
	getMessageBackHref,
	getMoveMessageActions,
	getReplyRecipients,
	getReplyThreading,
	hasAdditionalRecipients,
	openUnsubscribeUrl,
	runSingleMessageAction,
} from "./utils";

const MessageSourceDialog = lazy(() => import("@/components/messages/message-source-dialog").then(module => ({ default: module.MessageSourceDialog })));
const MessageSnoozeDialog = lazy(() => import("./message-snooze-dialog").then(module => ({ default: module.MessageSnoozeDialog })));
const InboxRules = lazy(() => import("@/components/settings/inbox-rules").then(module => ({ default: module.InboxRules })));

export function MessageActions({
	messageId,
	mailboxId,
	senderAddress,
	direction,
	status,
	read,
	unsubscribeUrl,
	subject,
	bodyText,
	ownAddress,
	ownAddresses = [],
	message,
	messageMeta,
	bodyHtml,
}: MessageActionsProps) {
	const { t } = useLanguage();
	const router = useRouter();
	const isMobile = useIsMobile();
	const iconSize = isMobile ? 20 : 16;
	const { openDraftComposer } = useCompose();
	const { shortcutsEnabled } = useShortcuts();
	const [pendingAction, setPendingAction] = useState<
		BulkMessageAction | "unsubscribe" | ReplyMode | "forward" | "block" | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [filterOpen, setFilterOpen] = useState(false);
	const { selectedMailbox, mailboxes } = useSelectedMailbox();
	const filterMailbox = selectedMailbox?.id === mailboxId ? selectedMailbox : mailboxes.find(box => box.id === mailboxId);
	const canCreateFilter = direction === "inbound" && !!mailboxId && filterMailbox?.permission === "full_access";

	const runAction = useCallback(async (action: BulkMessageAction) => {
		setMoreOpen(false);
		setPendingAction(action);
		setError(null);
		try {
			await runSingleMessageAction(messageId, action);
			const redirect = getMessageActionRedirect(action, direction);
			if (redirect) router.push(redirect);
			router.refresh();
		} catch {
			setError(t("actions.error.update"));
		} finally {
			setPendingAction(null);
		}
	}, [messageId, direction, router, t]);

	// In Trash and Spam the delete button removes the message for good instead of
	// being a no-op, after the user confirms.
	const canDeleteForever = supportsPermanentDelete(status);
	const deleteForever = useCallback(async () => {
		if (!window.confirm(getPermanentDeleteConfirmText(1, t))) return;
		setMoreOpen(false);
		setPendingAction("delete");
		setError(null);
		try {
			await runSingleMessageAction(messageId, "delete");
			router.push(getMessageBackHref(direction, status));
			router.refresh();
		} catch {
			setError(t("actions.error.delete"));
			setPendingAction(null);
		}
	}, [messageId, direction, status, router, t]);
	const onTrashClick = () => (canDeleteForever ? void deleteForever() : void runAction("trash"));
	const trashLabel = canDeleteForever ? t("common.deleteForever") : t("actions.moveToTrash");

	const replyable = useMemo(() => message ?? {
		direction,
		fromAddr: senderAddress,
		toAddr: "",
		ccAddr: null,
		replyTo: null,
		providerMessageId: null,
		references: null,
		threadId: null,
	}, [message, direction, senderAddress]);
	const canReplyAll = hasAdditionalRecipients(replyable, ownAddresses);

	const handleReply = useCallback(async (mode: ReplyMode) => {
		setPendingAction(mode);
		setError(null);
		try {
			const draftId = await createReplyDraft({
				mailboxId,
				senderAddress,
				ownAddress,
				subject,
				bodyText,
				bodyHtml,
				sentAt: messageMeta?.createdAt,
				recipients: getReplyRecipients(replyable, ownAddresses, mode),
				threading: getReplyThreading(replyable),
			});
			openDraftComposer(draftId);
		} catch (replyError) {
			setError(replyError instanceof Error ? replyError.message : t("message.error.reply"));
		} finally {
			setPendingAction(null);
		}
	}, [mailboxId, senderAddress, ownAddress, subject, bodyText, bodyHtml, messageMeta, replyable, ownAddresses, openDraftComposer, t]);

	const shortcuts = useMemo(
		() => [
			{
				key: "e",
				label: t("shortcut.archiveMessage"),
				category: "Actions" as const,
				action: () => {
					if (status !== "archived") void runAction("archive");
				},
			},
			{
				key: "y",
				label: t("shortcut.archiveMessage"),
				category: "Actions" as const,
				action: () => {
					if (status !== "archived") void runAction("archive");
				},
			},
			{
				key: "#",
				label: t("shortcut.moveToTrash"),
				category: "Actions" as const,
				action: () => {
					if (status !== "trash") void runAction("trash");
				},
			},
			{
				key: "r",
				label: t("shortcut.replyToMessage"),
				category: "Composing" as const,
				action: () => void handleReply("reply"),
			},
			{
				key: "!",
				label: t("shortcut.reportSpam"),
				category: "Actions" as const,
				action: () => {
					if (status !== "spam" && direction === "inbound") void runAction("spam");
				},
			},
			{
				key: "u",
				label: t("shortcut.backToList"),
				category: "Navigation" as const,
				action: () => router.back(),
			},
		],
		[status, direction, runAction, handleReply, router, t]
	);

	useHotkeys(shortcuts, { enabled: shortcutsEnabled });

	async function onUnsubscribe() {
		setMoreOpen(false);
		setError(null);
		if (unsubscribeUrl) {
			openUnsubscribeUrl(unsubscribeUrl);
			return;
		}

		if (!confirmTrashWithoutUnsubscribe()) return;
		setPendingAction("unsubscribe");
		if (!mailboxId) {
			setError(t("actions.error.trashRule"));
			setPendingAction(null);
			return;
		}

		try {
			await createTrashSenderRule({ mailboxId, senderAddress });
			await runAction("trash");
		} catch {
			setError(t("actions.error.trashRule"));
			setPendingAction(null);
		}
	}

	async function handleForward() {
		if (!message || !messageMeta) return;
		setPendingAction("forward");
		setError(null);
		try {
			const draftId = await createForwardDraft({
				mailboxId,
				ownAddress,
				message: { ...message, ...messageMeta },
				bodyText,
				bodyHtml,
			});
			openDraftComposer(draftId);
		} catch (forwardError) {
			setError(forwardError instanceof Error ? forwardError.message : t("message.error.forward"));
		} finally {
			setPendingAction(null);
		}
	}
	async function onBlockContact() {
		setMoreOpen(false);
		setError(null);
		if (!mailboxId) {
			setError(t("message.error.block"));
			return;
		}

		setPendingAction("block");
		try {
			await blockMessageContact({ mailboxId, senderAddress });
			await runSingleMessageAction(messageId, "trash");
			router.push("/trash");
			router.refresh();
		} catch (blockError) {
			setError(blockError instanceof Error ? blockError.message : t("message.error.block"));
		} finally {
			setPendingAction(null);
		}
	}

	const disabled = pendingAction !== null;
	const markAction: BulkMessageAction = read ? "unread" : "read";
	const moveActions = getMoveMessageActions(status, direction);

	return (
		<div className="flex flex-wrap items-center gap-3 text-neutral-600 flex-1 min-w-0 max-md:flex-nowrap max-md:justify-end max-md:gap-1">
			{error && <span className="text-xs text-red-600">{error}</span>}

			{isMobile && (
				<>
					<Button type="button" variant="ghost" size="roundedSM" data-mobile-reply className="h-11 w-11 shrink-0" title={t("message.reply")} aria-label={t("message.reply")} disabled={disabled} onClick={() => void handleReply("reply")}>
						<Reply aria-hidden="true" size={iconSize} />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						className="h-11 w-11"
						aria-label={t("common.archive")}
						disabled={disabled || status === "archived"}
						onClick={() => runAction("archive")}
					>
						<Archive size={iconSize} />
					</Button>
					<Button
						variant="ghost"
						size="roundedSM"
						aria-label={trashLabel}
						className="h-11 w-11"
						disabled={disabled}
						onClick={onTrashClick}
					>
						<Trash2 size={iconSize} />
					</Button>

				</>
			)}
			{!isMobile && (
				<>
			<Tooltip label={shortcutsEnabled ? t("actions.archiveHint") : t("common.archive")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={shortcutsEnabled ? t("actions.archiveHint") : t("common.archive")}
					disabled={disabled || status === "archived"}
					onClick={() => runAction("archive")}
				>
					<Archive size={iconSize} />
				</Button>
			</Tooltip>
			<Tooltip label={shortcutsEnabled ? t("actions.reportSpamHint") : t("common.reportSpam")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={shortcutsEnabled ? t("actions.reportSpamHint") : t("common.reportSpam")}
					disabled={disabled || status === "spam" || direction !== "inbound"}
					onClick={() => runAction("spam")}
				>
					<ShieldAlert size={iconSize} />
				</Button>
			</Tooltip>
			<Tooltip label={canDeleteForever ? t("common.deleteForever") : shortcutsEnabled ? t("actions.deleteHint") : t("common.delete")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={canDeleteForever ? trashLabel : shortcutsEnabled ? t("actions.moveToTrashHint") : t("actions.moveToTrash")}
					disabled={disabled}
					onClick={onTrashClick}
					className={canDeleteForever ? "text-red-600 hover:text-red-700" : undefined}
				>
					<Trash2 size={iconSize} />
				</Button>
			</Tooltip>
			<span className="h-5 mx-2 bg-gray-200 w-px inline-block" />


			<Tooltip label={shortcutsEnabled ? t("actions.replyHint") : t("message.reply")}>
				<Button
					type="button"
					variant="ghost"
					size="roundedSM"
					aria-label={shortcutsEnabled ? t("actions.replyHint") : t("message.reply")}
					disabled={disabled}
					onClick={() => handleReply("reply")}
				>
					<Reply size={iconSize} />
				</Button>
			</Tooltip>
			{canReplyAll && (
				<Tooltip label={t("message.replyAll")}>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						aria-label={t("message.replyAll")}
						disabled={disabled}
						onClick={() => handleReply("replyAll")}
					>
						<ReplyAll size={iconSize} />
					</Button>
				</Tooltip>
			)}
			{message && messageMeta && (
				<Tooltip label={t("message.forward")}>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						aria-label={t("message.forward")}
						disabled={disabled}
						onClick={() => void handleForward()}
					>
						<Forward size={iconSize} />
					</Button>
				</Tooltip>
			)}

			<Tooltip label={read ? t("common.markUnread") : t("common.markRead")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={read ? t("common.markUnread") : t("common.markRead")}
					disabled={disabled}
					onClick={() => runAction(markAction)}
				>
					{read ? <Mail size={iconSize} /> : <MailOpen size={iconSize} />}
				</Button>
			</Tooltip>
				</>
			)}
			<DropdownMenu.Root open={moreOpen} onOpenChange={setMoreOpen}>
				<Tooltip label={t("common.moreActions")}>
					<DropdownMenu.Trigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="roundedSM"
							className="max-md:h-11 max-md:w-11"
							aria-label={t("common.moreActions")}
							aria-expanded={moreOpen}
							disabled={disabled}
						>
							<MoreVertical size={iconSize} />
						</Button>
					</DropdownMenu.Trigger>
				</Tooltip>


				<MessageActionMenuContent>
					{isMobile && (
						<>
							<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100" onSelect={() => { setMoreOpen(false); void handleReply("reply"); }}>
								<Reply className="h-4 w-4" /> {t("message.reply")}
							</DropdownMenu.Item>
							<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100" disabled={status === "spam" || direction !== "inbound"} onSelect={() => void runAction("spam")}>
								<ShieldAlert className="h-4 w-4" /> {t("common.reportSpam")}
							</DropdownMenu.Item>
							<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" disabled={status === "archived"} onSelect={() => void runAction("archive")}>
								<Archive className="h-4 w-4" />
								{t("common.archive")}
							</DropdownMenu.Item>
							{canReplyAll && (
								<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" onSelect={() => { setMoreOpen(false); void handleReply("replyAll"); }}>
									<ReplyAll className="h-4 w-4" />
									{t("message.replyAll")}
								</DropdownMenu.Item>
							)}
							{message && messageMeta && (
								<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" onSelect={() => { setMoreOpen(false); void handleForward(); }}>
									<Forward className="h-4 w-4" />
									{t("message.forward")}
								</DropdownMenu.Item>
							)}
							<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" onSelect={() => void runAction(markAction)}>
								{read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
								{read ? t("common.markUnread") : t("common.markRead")}
							</DropdownMenu.Item>
							<DropdownMenu.Separator asChild><hr className="my-1 border-neutral-100" /></DropdownMenu.Separator>
						</>
					)}
					{direction === "inbound" && status === "received" && (
						<DropdownMenu.Item
							className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
							onSelect={() => { setMoreOpen(false); setSnoozeOpen(true); }}
						>
							<Clock className="h-4 w-4" />
							{t("common.snooze")}
						</DropdownMenu.Item>
					)}
					{direction === "inbound" && (
						<>
							<DropdownMenu.Item
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
								disabled={!unsubscribeUrl && status === "trash"}
								onSelect={() => void onUnsubscribe()}
							>
								<BellOff className="h-4 w-4 shrink-0" />
								{t("actions.unsubscribe")}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
								onSelect={() => void onBlockContact()}
							>
								<Ban className="h-4 w-4" />
								{t("message.blockContact")}
							</DropdownMenu.Item>
							<DropdownMenu.Separator asChild><hr className="my-1 border-neutral-100" /></DropdownMenu.Separator>
						</>
					)}
					{canCreateFilter && <DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100" onSelect={() => { setMoreOpen(false); setFilterOpen(true); }}>
						<ListFilter className="h-4 w-4" /> {t("rules.filterSimilar")}
					</DropdownMenu.Item>}
					<DropdownMenu.Item
						className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
						onSelect={() => { setMoreOpen(false); setSourceOpen(true); }}
					>
						<FileCode2 className="h-4 w-4" />
						{t("message.showOriginal")}
					</DropdownMenu.Item>
					<DropdownMenu.Separator asChild><hr className="my-1 border-neutral-100" /></DropdownMenu.Separator>
					<DropdownMenu.Label asChild><p className="mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500">
						{t("common.moveTo")}
					</p></DropdownMenu.Label>
					{moveActions.map((item) => (
						<DropdownMenu.Item
							key={item.action}
							className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
							onSelect={() => void runAction(item.action)}
						>
							{createElement(item.icon, { size: 16 })}
							{t(item.labelKey)}
						</DropdownMenu.Item>
					))}
				</MessageActionMenuContent>

			</DropdownMenu.Root>

			<Suspense fallback={<span role="status" className="px-3 text-sm text-neutral-500">{t("common.loading")}</span>}>
			{sourceOpen && <MessageSourceDialog messageId={messageId} open onOpenChange={setSourceOpen} />}
			{snoozeOpen && <MessageSnoozeDialog messageId={messageId} open onOpenChange={setSnoozeOpen} />}
			{filterOpen && mailboxId && <InboxRules sourceMessage={{id:messageId,mailboxId,fromAddr:senderAddress,subject:subject ?? messageMeta?.subject}} onClose={()=>setFilterOpen(false)} />}
			</Suspense>

			<span className="flex-1 max-md:hidden" />
		</div>
	);
}
