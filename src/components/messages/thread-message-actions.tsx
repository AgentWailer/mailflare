"use client";

import { createElement, useEffect, useState } from "react";
import { Ban, FileCode2, Forward, ListFilter, Mail, MailOpen, MoreVertical, Reply, ReplyAll, Star } from "lucide-react";
import { useCompose } from "@/components/compose/compose-context";
import { MessageSourceDialog } from "@/components/messages/message-source-dialog";
import { InboxRules } from "@/components/settings/inbox-rules";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getOwnAddressForMessage } from "@/app/(dashboard)/inbox/[messageId]/utils";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MessageActionMenuContent } from "@/components/messages/message-action-menu-content";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
	blockMessageContact,
	createForwardDraft,
	createReplyDraft,
	getMoveMessageActions,
	getReplyRecipients,
	getReplyThreading,
	hasAdditionalRecipients,
	runSingleMessageAction,
} from "@/components/message-actions/utils";
import { toggleMessageStar } from "./message-list-row-actions-utils";
import type { ThreadMessageActionsProps } from "./thread-message-actions-types";
import type { ReplyMode } from "@/components/message-actions/types";

export function ThreadMessageActions({
	message,
	mailboxId,
	ownAddress,
	ownAddresses = [],
	starOnly = false,
}: ThreadMessageActionsProps) {
	const { t } = useLanguage();
	const { openDraftComposer } = useCompose();
	const [starred, setStarred] = useState(message.starred);
	const [moreOpen, setMoreOpen] = useState(false);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [filterOpen, setFilterOpen] = useState(false);
	const { selectedMailbox, mailboxes } = useSelectedMailbox();
	const filterMailbox = selectedMailbox?.id === mailboxId ? selectedMailbox : mailboxes.find(box => box.id === mailboxId);
	const canCreateFilter = message.direction === "inbound" && !!mailboxId && filterMailbox?.permission === "full_access";
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canReplyAll = hasAdditionalRecipients(message, ownAddresses);
	const moveActions = getMoveMessageActions(message.status, message.direction);
	const replyFromAddress = ownAddresses.length > 0
		? getOwnAddressForMessage(message, ownAddresses)
		: ownAddress;

	useEffect(() => setStarred(message.starred), [message.starred]);
	useEffect(() => {
		if (starOnly) setMoreOpen(false);
	}, [starOnly]);

	async function onToggleStar() {
		setPending(true);
		setError(null);
		try {
			const result = await toggleMessageStar(message.id);
			setStarred(result.starred);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.star"));
		} finally {
			setPending(false);
		}
	}

	async function onReply(mode: ReplyMode) {
		setMoreOpen(false);
		setPending(true);
		setError(null);
		try {
			const draftId = await createReplyDraft({
				mailboxId,
				senderAddress: message.fromAddr,
				ownAddress: replyFromAddress,
				subject: message.subject,
				bodyText: message.textBody,
				bodyHtml: message.htmlBody,
				sentAt: message.createdAt,
				recipients: getReplyRecipients(message, ownAddresses, mode),
				threading: getReplyThreading(message),
			});
			openDraftComposer(draftId);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.reply"));
		} finally {
			setPending(false);
		}
	}

	async function onForward() {
		setMoreOpen(false);
		setPending(true);
		setError(null);
		try {
			const draftId = await createForwardDraft({
				mailboxId,
				ownAddress: replyFromAddress,
				message,
				bodyText: message.textBody,
				bodyHtml: message.htmlBody,
			});
			openDraftComposer(draftId);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.forward"));
		} finally {
			setPending(false);
		}
	}

	async function onMessageAction(action: Parameters<typeof runSingleMessageAction>[1]) {
		setMoreOpen(false);
		setPending(true);
		setError(null);
		try {
			await runSingleMessageAction(message.id, action);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.update"));
		} finally {
			setPending(false);
		}
	}

	async function onBlock() {
		if (!mailboxId) return;
		setMoreOpen(false);
		setPending(true);
		setError(null);
		try {
			await blockMessageContact({ mailboxId, senderAddress: message.fromAddr });
			await runSingleMessageAction(message.id, "trash");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.block"));
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="flex items-center gap-0.5">
			{error && <span className="mr-1 max-w-32 truncate text-xs text-red-600" title={error}>{error}</span>}
			<Tooltip label={starred ? t("message.removeStar") : t("message.star")}>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-8 w-8 px-0"
					aria-label={starred ? t("message.removeStar") : t("message.star")}
					aria-pressed={starred}
					disabled={pending}
					onClick={() => void onToggleStar()}
				>
					<Star className={starred ? "h-4 w-4 fill-amber-400 text-amber-400" : "h-4 w-4"} />
				</Button>
			</Tooltip>
			{!starOnly && (
				<>
			<Tooltip label={t("message.reply")}>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-8 w-8 px-0"
					aria-label={t("message.reply")}
					disabled={pending}
					onClick={() => void onReply("reply")}
				>
					<Reply className="h-4 w-4" />
				</Button>
			</Tooltip>
			<DropdownMenu.Root open={moreOpen} onOpenChange={setMoreOpen}>
				<Tooltip label={t("common.moreActions")}>
					<DropdownMenu.Trigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-8 w-8 px-0 max-md:h-11 max-md:w-11"
							aria-label={t("common.moreActions")}
							aria-expanded={moreOpen}
							disabled={pending}
						>
							<MoreVertical className="h-4 w-4" />
						</Button>
					</DropdownMenu.Trigger>
				</Tooltip>
				<MessageActionMenuContent>
					<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => void onReply("reply")}>
						<Reply className="h-4 w-4" /> {t("message.reply")}
					</DropdownMenu.Item>
					{canReplyAll && (
						<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => void onReply("replyAll")}>
							<ReplyAll className="h-4 w-4" /> {t("message.replyAll")}
						</DropdownMenu.Item>
					)}
					<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => void onForward()}>
						<Forward className="h-4 w-4" /> {t("message.forward")}
					</DropdownMenu.Item>
					<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => { setMoreOpen(false); setSourceOpen(true); }}>
						<FileCode2 className="h-4 w-4" /> {t("message.showOriginal")}
					</DropdownMenu.Item>
					{canCreateFilter && <DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => { setMoreOpen(false); setFilterOpen(true); }}>
						<ListFilter className="h-4 w-4" /> {t("rules.filterSimilar")}
					</DropdownMenu.Item>}
					<DropdownMenu.Separator asChild><hr className="my-1 border-neutral-100" /></DropdownMenu.Separator>
					<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => void onMessageAction(message.read ? "unread" : "read")}>
						{message.read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
						{message.read ? t("common.markUnread") : t("common.markRead")}
					</DropdownMenu.Item>
					{moveActions.map((item) => (
						<DropdownMenu.Item key={item.action} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => void onMessageAction(item.action)}>
							{createElement(item.icon, { size: 16 })} {t(item.labelKey)}
						</DropdownMenu.Item>
					))}
					{message.direction === "inbound" && mailboxId && (
						<>
							<DropdownMenu.Separator asChild><hr className="my-1 border-neutral-100" /></DropdownMenu.Separator>
							<DropdownMenu.Item className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onSelect={() => void onBlock()}>
								<Ban className="h-4 w-4" /> {t("message.blockContact")}
							</DropdownMenu.Item>
						</>
					)}
				</MessageActionMenuContent>
			</DropdownMenu.Root>
			<MessageSourceDialog messageId={message.id} open={sourceOpen} onOpenChange={setSourceOpen} />
			{filterOpen && mailboxId && <InboxRules sourceMessage={{id:message.id,mailboxId,fromAddr:message.fromAddr,subject:message.subject}} onClose={()=>setFilterOpen(false)} />}
				</>
			)}
		</div>
	);
}
