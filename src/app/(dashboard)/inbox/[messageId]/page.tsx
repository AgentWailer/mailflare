"use client";

import { MailOrganizationButton } from "@/components/messages/mail-organization-button";
import { MessageReaderLabels } from "@/components/messages/message-reader-labels";
import { MessageEnvelopeDetails } from "@/components/messages/message-envelope-details";
import { MessageAiShortcuts } from "@/components/messages/message-ai-shortcuts";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Cloud, ExternalLink } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import { MarkAsRead } from "@/components/mark-read";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { ContactDetailsTrigger } from "@/components/contacts/contact-details";
import { SenderAvatar } from "@/components/messages/sender-avatar";
import { MessageActions } from "@/components/message-actions/message-actions";
import { MessageAttachmentViewer } from "@/components/message-attachment-viewer";
import { MessageAttachmentCard } from "@/components/message-attachment-card";
import { MessageDetailSkeleton } from "@/components/page-skeletons";
import { usePageLoading } from "@/components/page-loading";
import { PreviousMessage } from "@/components/previous-message";
import { ConversationThread } from "@/components/messages/conversation-thread";
import { MessageDetailNavigation } from "@/components/messages/message-detail-navigation";
import { MessageReadingHeaderButton } from "@/components/messages/message-reading-header-button";
import { MessageReaderToolbar } from "@/components/messages/message-reader-toolbar";
import { ScheduledSendBanner } from "@/components/messages/scheduled-send-banner";
import { formatScheduledSendTime } from "@/components/messages/scheduled-send-utils";
import { QuotedEmailToggle } from "@/components/messages/quoted-email-toggle";
import { ThreadMessageActions } from "@/components/messages/thread-message-actions";
import { useMessageThread } from "@/components/messages/use-message-thread";
import { useLatestMessagesFirst } from "@/components/messages/use-latest-messages-first";
import { useMessageListVisibility } from "@/components/messages/message-list-visibility";
import { splitEmailAddressList } from "@/lib/email/address";
import { RecipientList } from "@/components/messages/recipient-list";
import { useShowFullRecipientAddresses } from "@/components/messages/use-show-full-recipient-addresses";
import type { MessageAttachment, MessageDetailResponse } from "./types";
import {
  fetchMessageDetail,
  fetchMessageMetadata,
  getCachedMessageDetailForDisplay,
  getMessageBodyDisplay,
  getMessageHeaderParties,
  getOwnAddressForMessage,
  resolveInlineAttachmentUrls,
} from "./utils";
import { extractCloudAttachments } from "./cloud-attachment-utils";
import { EmailHtmlRenderer } from "@/components/messages/email-html-renderer";
import clsx from "clsx";
import { useAssistantOpen } from "@/components/agent/assistant-open-state";
import { useMessageContentScroll } from "./use-message-content-scroll";

export default function MessageDetailPage() {
  const { t } = useLanguage();
  const params = useParams<{ messageId: string }>();
  const { selectedMailbox, mailboxes } = useSelectedMailbox();
  const messageId = params.messageId;
  const [data, setData] = useState<MessageDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewAttachment, setPreviewAttachment] =
    useState<MessageAttachment | null>(null);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [latestMessagesFirst] = useLatestMessagesFirst();
  const { enabled: showFullRecipientAddresses } = useShowFullRecipientAddresses();
  const { visible: messageListVisible } = useMessageListVisibility();
  usePageLoading(loading);
  const thread = useMessageThread(messageId, data?.message?.threadId);
  const assistantVisible = useAssistantOpen();
  const isAnyPanelVisible = messageListVisible || assistantVisible;
  const { scrollRef, scrolled, handleScroll } = useMessageContentScroll(messageId, loading);

  useEffect(() => {
    let cancelled = false;

    async function loadMessage() {
      const cachedData = getCachedMessageDetailForDisplay(messageId);
      if (cachedData?.message && cachedData.body) {
        setData(cachedData);
        setLoading(false);
        if (cachedData.attachments !== undefined) return;
        try {
          const metadata = await fetchMessageMetadata(messageId);
          if (!cancelled) setData((current) => current ? { ...current, ...metadata } : current);
        } catch {
          // The message body remains usable if supplemental metadata is unavailable.
        }
        return;
      }
      setLoading(true);
      const nextData = await fetchMessageDetail(messageId);
      if (!cancelled) {
        setData(nextData);
        setLoading(false);
      }
    }

    void loadMessage();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(() => {
    setThreadExpanded(false);
  }, [messageId]);

  if (loading) {
    return <><MessageReaderToolbar><MessageReadingHeaderButton assistantVisible={assistantVisible} /></MessageReaderToolbar><div className="min-h-0 flex-1 overflow-y-auto"><MessageDetailSkeleton /></div></>;
  }

  if (!data?.message) {
    return (
      <>
      <MessageReaderToolbar><MessageReadingHeaderButton assistantVisible={assistantVisible} /></MessageReaderToolbar>
      <p className="px-6 py-4 text-sm text-neutral-500">
        {data?.error ?? t("message.notFound")}
      </p>
      </>
    );
  }

  const { message, body, attachments = [], scheduledAt } = data;
  const currentThreadMessage = {
    ...message,
    textBody: body?.textBody ?? null,
    htmlBody: body?.htmlBody ?? null,
    attachments,
  };
  const messageMailbox =
    mailboxes.find((mailbox) => mailbox.id === message.mailboxId) ?? selectedMailbox;
  const currentAccountName =
    messageMailbox?.displayName ?? messageMailbox?.localPart;
  const { fromName, fromAddress } = getMessageHeaderParties(
    message,
    currentAccountName,
  );
  const ownAddresses = messageMailbox
    ? messageMailbox.senderAddresses?.length
      ? messageMailbox.senderAddresses
      : [`${messageMailbox.localPart}@${messageMailbox.hostname}`]
    : [];
  const ownAddress = getOwnAddressForMessage(message, ownAddresses);
  const toEntries = splitEmailAddressList(message.toAddr);
  const bodyDisplay = getMessageBodyDisplay(
    body?.textBody,
    body?.htmlBody,
    message.snippet,
    ownAddress,
  );
  const htmlBody = (
    resolveInlineAttachmentUrls(bodyDisplay.htmlBody, message.id, attachments)
  );
  const quotedHtml = (
    resolveInlineAttachmentUrls(bodyDisplay.quotedHtml, message.id, attachments)
  );
  const cloudAttachmentResult = extractCloudAttachments(
    bodyDisplay.latestContent,
  );
  return (<>

    <MessageReaderToolbar scrolled={scrolled}>
      <MessageReadingHeaderButton assistantVisible={assistantVisible} />
      {/* <div className="min-w-0 flex-1" /> */}
      {/* <div className="flex items-center flex-row gap-6">
					<Link
						href={getMessageBackHref(message.direction, message.status)}
						className="rounded-full p-2 text-neutral-600 hover:bg-neutral-100"
					>
						<ArrowLeft className="h-5 w-5" />
					</Link>
				</div> */}
      <MessageActions
        messageId={message.id}
        mailboxId={message.mailboxId}
        senderAddress={message.fromAddr}
        direction={message.direction}
        status={message.status}
        read={message.read}
        unsubscribeUrl={data.unsubscribeUrl}
        subject={message.subject}
        bodyText={body?.textBody}
        ownAddress={ownAddress}
        ownAddresses={ownAddresses}
        message={message}
        messageMeta={message}
        bodyHtml={body?.htmlBody}
      />
      <MessageDetailNavigation messageId={message.id} />
    </MessageReaderToolbar>

    <div ref={scrollRef} onScroll={handleScroll} className="overflow-y-auto overscroll-contain scrollbar-gutter-stable flex-1 min-h-0">
      {!message.read && <MarkAsRead messageId={message.id} />}

      <div data-message-heading className={clsx(!isAnyPanelVisible ? "md:pl-16" : "md:pl-10", "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 pr-6")}>
        <h1 className="min-w-0 break-words text-xl leading-snug text-neutral-900" title={message.subject ?? t("list.noSubject")}>
          {message.subject ?? t("list.noSubject")}
        </h1>
        <MessageReaderLabels message={message} />
      </div>
      {/* <div className="px-6">
        <div className="mx-auto w-full max-w-[640px]">
          <SpamScoreDetails
            score={message.spamScore}
            verdict={message.spamVerdict}
            signals={message.spamSignals}
            analysisError={message.spamAnalysisError}
          />
        </div>
      </div> */}
      <ConversationThread
        currentMessageId={message.id}
        position={latestMessagesFirst ? "after" : "before"}
        messages={thread.messages}
        mailboxId={message.mailboxId}
        currentAccountName={currentAccountName}
        ownAddress={ownAddress}
        ownAddresses={ownAddresses}
        latestMessagesFirst={latestMessagesFirst}
        showFullRecipientAddresses={showFullRecipientAddresses}
        expandedAll={threadExpanded}
        onExpandedAllChange={setThreadExpanded}
      />
      <article data-message-content className={clsx("px-4 py-1 md:px-6", !isAnyPanelVisible && "md:pl-12")}>
        <div className="w-full">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 pb-2 md:pl-4">
            <div className="flex min-w-0 flex-1 basis-60 items-start gap-3">
              <SenderAvatar
                mailboxId={message.mailboxId}
                address={message.fromAddr}
                name={fromName}
                hasAvatar={message.direction === "inbound"}
                managedAvatarUrl={message.direction === "outbound" && message.mailboxId
                  ? `/api/mailboxes/${message.mailboxId}/avatar`
                  : undefined}
              />
              <div className="flex-1 min-w-0">
                <p className="flex w-full min-w-0 items-center gap-1 overflow-hidden text-sm leading-5 text-neutral-900">
                  <b className="min-w-0 truncate">
                    {message.direction === "inbound" ? (
                      <ContactDetailsTrigger
                        mailboxId={message.mailboxId}
                        address={message.fromAddr}
                        name={fromName}
                      />
                    ) : (
                      fromName
                    )}
                  </b>{" "}
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-500" title={fromAddress}>&lt;{fromAddress}&gt;</span>
                </p>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <p className="min-w-0 max-w-full truncate text-xs text-neutral-500">
                    {t("source.to").toLowerCase()}{" "}
                    <RecipientList
                      entries={toEntries}
                      mailboxId={message.mailboxId}
                      style={showFullRecipientAddresses ? "full" : "address"}
                    />
                  </p>
                  <MessageEnvelopeDetails message={message} compact mailboxAddress={messageMailbox ? `${messageMailbox.localPart}@${messageMailbox.hostname}` : undefined} />
                </div>
              </div>
            </div>
            <div data-message-header-actions className="flex max-w-full flex-wrap items-center justify-end gap-0 sm:gap-1">
              <p className="mr-1 text-xs">
                {scheduledAt
                  ? formatScheduledSendTime(scheduledAt, t)
                  : <><span className="hidden sm:inline">{formatUserDate(message.createdAt, { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span className="sm:hidden">{formatUserDate(message.createdAt, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></>}
              </p>
              <MessageAiShortcuts message={message} compact />
              {message.mailboxId && <MailOrganizationButton messageIds={[message.id]} mailboxId={message.mailboxId} />}
              <ThreadMessageActions
                message={currentThreadMessage}
                mailboxId={message.mailboxId}
                ownAddress={ownAddress}
                ownAddresses={ownAddresses}
                starOnly={!thread.messages.some((threadMessage) => threadMessage.id === message.id) || !thread.messages.some((threadMessage) => threadMessage.id !== message.id)}
              />
            </div>
          </div>
          {scheduledAt && <div className="pl-10"><ScheduledSendBanner messageId={message.id} scheduledAt={scheduledAt} /></div>}
          <div className="prose max-w-none md:pl-16 text-neutral-900">
            {htmlBody ? (
              <EmailHtmlRenderer key={message.id} className="mx-auto" html={htmlBody} />
            ) : (
              <pre className="whitespace-pre-wrap text-sm text mx-auto">
                {cloudAttachmentResult.content}
              </pre>
            )}
            {quotedHtml && <QuotedEmailToggle html={quotedHtml} />}
            {bodyDisplay.quotedContent.map((quotedContent) => (
              <PreviousMessage
                key={`${quotedContent.dateLine}-${quotedContent.content.slice(0, 24)}`}
                message={quotedContent}
              />
            ))}
          </div>
          {cloudAttachmentResult.attachments.length > 0 && (
            <section className="mt-8 border-t border-neutral-100 py-6 pl-16">
              <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                {t("message.cloudFiles", { count: cloudAttachmentResult.attachments.length })}
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {cloudAttachmentResult.attachments.map((attachment) => (
                  <a
                    key={attachment.id}
                    href={attachment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 text-left hover:border-blue-200 hover:bg-blue-50/40"
                  >
                    <Cloud className="h-5 w-5 shrink-0 text-blue-600" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-neutral-900">
                        {attachment.filename}
                      </span>
                      <span className="block text-xs text-neutral-500">
                        {t("message.openFrom", { provider: attachment.provider })}
                      </span>
                    </span>
                    <ExternalLink className="h-4 w-4 shrink-0 text-neutral-400" />
                  </a>
                ))}
              </div>
            </section>
          )}
          {attachments.length > 0 && (
            <section className="mt-8 border-t border-neutral-100 py-6 pl-16">
              <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                {t("message.attachments", { count: attachments.length })}
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {attachments.map((attachment) => (
                  <MessageAttachmentCard
                    key={attachment.id}
                    attachment={attachment}
                    messageId={message.id}
                    onPreview={setPreviewAttachment}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </article>
      <ConversationThread
        currentMessageId={message.id}
        position={latestMessagesFirst ? "before" : "after"}
        messages={thread.messages}
        mailboxId={message.mailboxId}
        currentAccountName={currentAccountName}
        ownAddress={ownAddress}
        ownAddresses={ownAddresses}
        latestMessagesFirst={latestMessagesFirst}
        showFullRecipientAddresses={showFullRecipientAddresses}
        expandedAll={threadExpanded}
        onExpandedAllChange={setThreadExpanded}
      />
      <MessageAttachmentViewer
        attachment={previewAttachment}
        messageId={message.id}
        open={previewAttachment !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewAttachment(null);
        }}
      />
    </div>
  </>
  );
}

