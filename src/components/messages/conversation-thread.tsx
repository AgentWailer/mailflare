"use client";

import { useEffect, useState } from "react";
import { formatUserDate } from "@/lib/time/utils";
import { ChevronsUpDown, Paperclip } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { QuotedEmailToggle } from "@/components/messages/quoted-email-toggle";
import { runSingleMessageAction } from "@/components/message-actions/utils";
import { EmailHtmlRenderer } from "./email-html-renderer";
import { getMessageBodyDisplay, resolveInlineAttachmentUrls } from "@/app/(dashboard)/inbox/[messageId]/utils";

import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import type { ConversationMessageCardProps, ConversationThreadProps } from "./conversation-thread-types";
import { ThreadMessageActions } from "./thread-message-actions";
import {
	getConversationRecipients,
	getConversationSender,
	getConversationSenderEmail,
	partitionThread,
} from "./conversation-thread-utils";
import clsx from "clsx";
import { fetchCachedMessageDetail } from "@/lib/messages/detail-cache";
import type { CachedMessageDetail } from "@/lib/messages/detail-cache-types";

/**
 * The other messages in a conversation, ordered oldest to newest and collapsed
 * until opened. Readers can also expand the full visible portion at once.
 */
export function ConversationThread({
	currentMessageId,
	position,
	messages,
	mailboxId,
	currentAccountName,
	ownAddress,
	ownAddresses,
	latestMessagesFirst,
	expandedAll,
	onExpandedAllChange,
	showFullRecipientAddresses = false,
}: ConversationThreadProps) {
	const { t } = useLanguage();
	const slice = partitionThread(messages, currentMessageId, position, latestMessagesFirst);
	if (slice.length === 0) return null;
	const firstMessage = slice[0];
	const lastMessage = slice.at(-1)!;
	const middleMessages = slice.slice(1, -1);
	const collapsed = !expandedAll && middleMessages.length > 0;
	const collapsedLabel = t(position === "before" ? "thread.messagesCollapsed.older" : "thread.messagesCollapsed.newer", { count: middleMessages.length });

	return (
		<section
			aria-label={position === "before" ? t("thread.earlier") : t("thread.later")}
			className={cn(position === (latestMessagesFirst ? "before" : "after") ? "pb-6" : "")}
		>
			<ol className={cn(!collapsed && "divide-y divide-neutral-200/50", latestMessagesFirst ? "border-t" : "border-b", "border-neutral-200")}>
				<li className={"border-t-0"}>
					<ConversationMessageCard
						message={firstMessage}
						mailboxId={mailboxId}
						currentAccountName={currentAccountName}
						ownAddress={ownAddress}
						ownAddresses={ownAddresses}
						showFullRecipientAddresses={showFullRecipientAddresses}
					/>
				</li>
				{collapsed ? (
					<li className="flex items-center justify-center gap-1 py-2 text-center border-y border-neutral-100 h-px my-4">
						<span className="bg-white px-6 flex flex-row items-center gap-2">
							<span className="text-sm font-medium text-neutral-600">{collapsedLabel}</span>
							<button
								type="button"
								onClick={() => onExpandedAllChange(true)}
								aria-label={t("thread.expand", { label: collapsedLabel })}
								title={t("thread.expand", { label: collapsedLabel })}
								className="inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
							>
								<ChevronsUpDown className="h-4 w-4" />
							</button>
						</span>
					</li>
				) : (
					middleMessages.map((message) => (
						<li key={message.id}>
							<ConversationMessageCard
								message={message}
								mailboxId={mailboxId}
								currentAccountName={currentAccountName}
								ownAddress={ownAddress}
								ownAddresses={ownAddresses}
								showFullRecipientAddresses={showFullRecipientAddresses}
							/>
						</li>
					))
				)}
				{lastMessage.id !== firstMessage.id && (
					<li>
						<ConversationMessageCard
							message={lastMessage}
							mailboxId={mailboxId}
							currentAccountName={currentAccountName}
							ownAddress={ownAddress}
							ownAddresses={ownAddresses}
							showFullRecipientAddresses={showFullRecipientAddresses}
						/>
					</li>
				)}
			</ol>
		</section>
	);
}

export function ConversationMessageCard({
	message: summary,
	mailboxId,
	currentAccountName,
	ownAddress,
	ownAddresses,
	defaultExpanded = false,
	showFullRecipientAddresses = false,
}: ConversationMessageCardProps) {
	const { t } = useLanguage();
	const [locallyExpanded, setLocallyExpanded] = useState(defaultExpanded);
	const [detail, setDetail] = useState<CachedMessageDetail | null>(null);
	const [loadFailure, setLoadFailure] = useState<{id:string;attempt:number} | null>(null);
	const [attempt, setAttempt] = useState(0);
	const loadFailed = loadFailure?.id === summary.id && loadFailure.attempt === attempt;
	const loadedBody = detail?.message?.id === summary.id ? detail.body : null;
	const message = loadedBody ? { ...summary, ...loadedBody, bodyLoaded: true } : summary;
	const [readState, setReadState] = useState({ id: summary.id, source: summary.read, value: summary.read });
	const readSourceChanged = readState.id !== summary.id || readState.source !== summary.read;
	if (readSourceChanged) setReadState({ id: summary.id, source: summary.read, value: summary.read });
	const locallyRead = readSourceChanged ? summary.read : readState.value;
	const setLocallyRead = (value: boolean) => setReadState({ id: summary.id, source: summary.read, value });
	const expanded = locallyExpanded;
	const needsBody = summary.bodyLoaded === false && !loadedBody;
	const sender = getConversationSender(message, currentAccountName);
	const senderEmail = getConversationSenderEmail(message);
	const recipients = getConversationRecipients(message, showFullRecipientAddresses ? "full" : "address");
	// const href = `${getMessageBackHref(message.direction, message.status)}/${message.id}`;
	const outbound = message.direction === "outbound";
	const attachments = message.attachments.filter((attachment) => attachment.disposition === "attachment");

	useEffect(() => {
		if (!expanded || !needsBody) return;
		let cancelled = false;
		void fetchCachedMessageDetail(summary.id).then(data => {
			if (!data.body) throw new Error("Missing message body");
			if (!cancelled) setDetail(data);
		}).catch(() => { if (!cancelled) setLoadFailure({ id: summary.id, attempt }); });
		return () => { cancelled = true; };
	}, [expanded, needsBody, summary.id, attempt]);

	let body: { html: string | null; text: string; quotedHtml: string | null } | null = null;
	if (expanded && !needsBody) {
		const display = getMessageBodyDisplay(message.textBody, message.htmlBody, message.snippet);
		body = {
			html: resolveInlineAttachmentUrls(display.htmlBody, message.id, message.attachments),
			text: display.latestContent,
			quotedHtml: resolveInlineAttachmentUrls(display.quotedHtml, message.id, message.attachments),
		};
	}


	return (
		<article className={cn("message-reader-gutter bg-white transition-colors", !expanded && "hover:bg-neutral-50")}>
			<div className="w-full">
				<div className="flex w-full flex-wrap items-start gap-x-3 py-3">
					<button
						type="button"
						onClick={() => {
							const shouldExpand = !locallyExpanded;
							setLocallyExpanded(shouldExpand);
							if (shouldExpand) setLoadFailure(null);
							if (!shouldExpand || locallyRead) return;
							setLocallyRead(true);
							void runSingleMessageAction(message.id, "read").catch(() => setLocallyRead(false));
						}}
						aria-expanded={expanded}
						className="flex min-w-0 flex-1 basis-40 items-center gap-3 text-left cursor-pointer"
					>
						<ContactAvatar
							mailboxId={mailboxId}
							address={message.fromAddr}
							name={sender}
							hasManagedAvatar={message.fromContactHasAvatar}
							managedAvatarUrl={outbound && mailboxId ? `/api/mailboxes/${mailboxId}/avatar` : undefined}
							className={expanded ? "mt-1" : ""}
						/>
						<span className="min-w-0 flex-1">
							<div className="flex flex-col">
								<span className={cn("truncate text-sm font-semibold mt-1", locallyRead || outbound ? "text-neutral-900" : "font-semibold text-neutral-900")}>
									{sender}
									{expanded && <span className="text-xs ml-1 opacity-50 font-normal">&lt;{senderEmail}&gt;</span>}
								</span>
								{expanded && recipients && <span className="text-xs font-normal text-neutral-500">{t("thread.to", { recipients })}</span>}
							</div>
							{!expanded && (
								<span className={clsx(!locallyRead ? "font-semibold" : "text-neutral-500", "block truncate text-[13px]")}>{message.snippet || t("thread.noPreview")}</span>
							)}
						</span>
					</button>
					<span className={clsx(!locallyRead ? "font-semibold" : "", "flex shrink-0 items-center gap-2 text-xs mr-2 mt-2")}>
						{attachments.length > 0 && <Paperclip className="h-3.5 w-3.5" aria-label={t("thread.attachmentCount", { count: attachments.length })} />}
						{formatUserDate(message.createdAt, { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
					</span>
					<ThreadMessageActions
						message={message}
						mailboxId={mailboxId}
						ownAddress={ownAddress}
						ownAddresses={ownAddresses}
						starOnly={!expanded || needsBody}
					/>
				</div>
				{expanded && needsBody && <div className="pb-4 text-sm text-neutral-600" role={loadFailed ? "alert" : "status"}>
					{loadFailed ? <><p>{t("message.loadFailed")}</p><button type="button" className="mt-2 rounded-lg border px-3 py-2" onClick={() => setAttempt(value => value + 1)}>{t("message.retry")}</button></> : t("nav.loadingPage")}
				</div>}
				{expanded && body && (
					<div className="pb-4 pt-2">
						{body.html ? (
							<EmailHtmlRenderer html={body.html} />
						) : (
							<pre className="whitespace-pre-wrap font-sans text-sm text-neutral-900">{body.text}</pre>
						)}
						{body.quotedHtml && <QuotedEmailToggle html={body.quotedHtml} />}
						{attachments.length > 0 && (
							<ul className="mt-4 flex flex-wrap gap-2">
								{attachments.map((attachment) => (
									<li key={attachment.id}>
										<a
											href={`/api/messages/${message.id}/attachments/${attachment.id}`}
											className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
										>
											<Paperclip className="h-3 w-3" />
											<span className="max-w-48 truncate">{attachment.filename}</span>
										</a>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
			</div>
		</article>
	);
}
