"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ChevronDown, ChevronUp, FileText, Forward, Maximize2, Minimize2, Minus, Paperclip, Reply, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { recoveryKey, readRecovery, writeRecovery } from "./draft-recovery";
import type { DraftPayload } from "@/app/api/drafts/types";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import { SendReview } from "@/components/agent/send-review";
import type { ReviewSnapshot } from "@/components/agent/send-review-types";
import { buildSendFormData, fetchDraft, formatAttachmentSize } from "./utils";
import { RecipientInput } from "./recipient-input";
import { addressChipClassName, addressLabelClassName, addressRowClassName } from "./address-field-styles";
import { RichTextEditor } from "./rich-text-editor";
import { ScheduleSendMenu } from "./schedule-send-menu";
import { useComposeScrollLock } from "./use-compose-scroll-lock";
import { useComposeViewport } from "./use-compose-viewport";
import {
	applyMailboxSignatureHtml,
	hasMeaningfulHtml,
	htmlToPlainText,
	joinQuotedHtml,
	splitQuotedHtml,
	textToHtml,
} from "./rich-text-utils";
import { headerToRecipients, isValidRecipient, recipientsToHeader } from "./recipient-utils";
import type { ComposeAttachment, ComposeStoredAttachment, ComposeThreading } from "./types";
import type { ComposeAttachmentPolicy } from "./attachment-policy-types";

type Toast = { type: "success" | "error"; message: string } | null;

export function ComposeForm({
	mode = "page",
	draftIdToLoad,
	onClose,
}: {
	mode?: "page" | "popup";
	draftIdToLoad?: string | null;
	onClose?: () => void;
}) {
	const { t } = useLanguage();
	const router = useRouter();
	const { selectedMailbox, setSelectedMailbox, mailboxes } = useSelectedMailbox();
	const [draftId, setDraftId] = useState<string | null>(null);
	const [agentRevision, setAgentRevision] = useState<number | null>(null);
	const [agentReview, setAgentReview] = useState<{ approvalId: string; snapshot: ReviewSnapshot } | null>(null);
	const [to, setTo] = useState<string[]>([]);
	const [cc, setCc] = useState<string[]>([]);
	const [bcc, setBcc] = useState<string[]>([]);
	const [showCc, setShowCc] = useState(false);
	const [showBcc, setShowBcc] = useState(false);
	const [threading, setThreading] = useState<ComposeThreading | null>(null);
	const [subject, setSubject] = useState("");
	// The body is HTML; quoted/forwarded content is kept aside and folded.
	const [html, setHtml] = useState("");
	const [quotedHtml, setQuotedHtml] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	// Attachments the draft already holds server-side (a forwarded message's files).
	const [storedAttachments, setStoredAttachments] = useState<ComposeStoredAttachment[]>([]);
	const [attachmentPolicy, setAttachmentPolicy] = useState<ComposeAttachmentPolicy>({ maxMb: 25, cloudThresholdBytes: 3_000_000 });
	const [draggingFiles, setDraggingFiles] = useState(false);
	const [modalMode, setModalMode] = useState(false);
	const [minimized, setMinimized] = useState(false);
	const [toast, setToast] = useState<Toast>(null);
	const [refineActive, setRefineActive] = useState(false);
	const [draftSaveFailed, setDraftSaveFailed] = useState(false);
	const [draftSaving, setDraftSaving] = useState(false);
	const [draftRestored, setDraftRestored] = useState(false);
	const frameRef = useRef<HTMLFormElement | null>(null);
	useComposeViewport(frameRef, !minimized, mode);
	useComposeScrollLock(frameRef, mode === "popup" && !minimized, modalMode);
	const [loading, setLoading] = useState(false);
	const [loadingDraft, setLoadingDraft] = useState(false);
	const [deletingDraft, setDeletingDraft] = useState(false);
	const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
	const [loadedDraftMailboxId, setLoadedDraftMailboxId] = useState<string | null>(null);
	const [loadedDraftFrom, setLoadedDraftFrom] = useState<string | null>(null);
	const [selectedFrom, setSelectedFrom] = useState("");
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const draftGeneration = useRef(0);
	const saveChain = useRef<Promise<void>>(Promise.resolve());
	const savedDraftId = useRef<string | null>(null);
	const creationStarted = useRef(false);
	const draftRequestId = useRef<string | null>(null);
	const journalKey = useRef<string | null>(null);
	const recoveryLoaded = useRef(false);
	const dirtyDraft = useRef(false);
	const flushSave = useRef<(() => void) | null>(null);
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => { if (dirtyDraft.current) { event.preventDefault(); event.returnValue = ""; } };
		window.addEventListener("beforeunload", warn);
		return () => { window.removeEventListener("beforeunload", warn); if (dirtyDraft.current) flushSave.current?.(); };
	}, []);
	const attachmentInput = useRef<HTMLInputElement | null>(null);
	const fileDragDepth = useRef(0);
	const previousSignature = useRef("");

	useEffect(() => {
		if (!selectedMailbox && mailboxes.length === 1) setSelectedMailbox(mailboxes[0]);
	}, [mailboxes, selectedMailbox, setSelectedMailbox]);

	useEffect(() => {
		let active = true;
		void authFetch("/api/attachment-policy", { cache: "no-store" }).then(async (response) => {
			if (response.ok && active) setAttachmentPolicy((await response.json()) as ComposeAttachmentPolicy);
		}).catch(() => {});
		return () => { active = false; };
	}, []);

	const senderAddresses = useMemo(() => {
		if (!selectedMailbox) return [];
		return selectedMailbox.senderAddresses?.length
			? selectedMailbox.senderAddresses
			: [`${selectedMailbox.localPart}@${selectedMailbox.hostname}`];
	}, [selectedMailbox]);
	const senderOptions = useMemo(
		() => mailboxes.flatMap((mailbox) => {
			const addresses = mailbox.senderAddresses?.length
				? mailbox.senderAddresses
				: [`${mailbox.localPart}@${mailbox.hostname}`];
			return addresses.map((address) => ({ mailbox, address }));
		}),
		[mailboxes],
	);
	const fromAddr = selectedMailbox && selectedFrom
		? formatEmailAddress(selectedFrom, selectedMailbox.displayName)
		: "";

	useEffect(() => {
		if (!senderAddresses.length) {
			setSelectedFrom("");
			return;
		}
		if (!senderAddresses.includes(selectedFrom)) setSelectedFrom(senderAddresses[0]);
	}, [selectedFrom, senderAddresses]);

	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), 3200);
		return () => clearTimeout(timer);
	}, [toast]);

	useEffect(() => {
		if (!draftIdToLoad) return;

		let cancelled = false;
		setLoadingDraft(true);
		fetchDraft(draftIdToLoad)
			.then((draft) => {
				if (cancelled) return;

				savedDraftId.current = draft.id;
				setDraftId(draft.id);
				setAgentRevision(draft.agent?.revision ?? null);
				setScheduledAt(draft.agent?.scheduledAt ? new Date(draft.agent.scheduledAt) : null);
				setTo(headerToRecipients(draft.toAddr));
				const draftCc = headerToRecipients(draft.ccAddr);
				const draftBcc = headerToRecipients(draft.bccAddr);
				setCc(draftCc);
				setBcc(draftBcc);
				setShowCc(draftCc.length > 0);
				setShowBcc(draftBcc.length > 0);
				setThreading(
					draft.inReplyTo || draft.threadId
						? {
							inReplyTo: draft.inReplyTo ?? null,
							references: draft.references ?? null,
							threadId: draft.threadId ?? null,
						}
						: null,
				);
				setSubject(draft.subject ?? "");
				const stored = splitQuotedHtml(draft.htmlBody || textToHtml(draft.textBody));
				setHtml(stored.body);
				setQuotedHtml(stored.quoted);
				setStoredAttachments(draft.attachments?.filter((item) => item.disposition === "attachment") ?? []);
				setLoadedDraftMailboxId(draft.mailboxId);
				setLoadedDraftFrom(getEmailAddress(draft.fromAddr).toLowerCase());
			})
			.catch((err) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : t("compose.error.loadDraft");
				setToast({ type: "error", message });
			})
			.finally(() => {
				if (!cancelled) setLoadingDraft(false);
			});

		return () => {
			cancelled = true;
		};
	}, [draftIdToLoad]);

	useEffect(() => {
		if (!loadedDraftMailboxId) return;
		if (selectedMailbox?.id === loadedDraftMailboxId) return;

		const draftMailbox = mailboxes.find((mailbox) => mailbox.id === loadedDraftMailboxId);
		if (draftMailbox) setSelectedMailbox(draftMailbox);
	}, [loadedDraftMailboxId, mailboxes, selectedMailbox?.id, setSelectedMailbox]);

	useEffect(() => {
		if (!loadedDraftFrom || !senderAddresses.includes(loadedDraftFrom)) return;
		setSelectedFrom(loadedDraftFrom);
	}, [loadedDraftFrom, senderAddresses]);

	useEffect(() => {
		if (loadingDraft) return;
		const nextSignature = selectedMailbox?.signature ?? "";
		setHtml((current) => applyMailboxSignatureHtml(current, previousSignature.current, nextSignature));
		previousSignature.current = nextSignature;
	}, [loadingDraft, selectedMailbox?.id, selectedMailbox?.signature]);

	useEffect(() => {
		if (!selectedMailbox || loadingDraft || deletingDraft || (draftIdToLoad && !draftId)) return;
		if (!recoveryLoaded.current) {
			recoveryLoaded.current = true;
			journalKey.current = recoveryKey(selectedMailbox.id, draftIdToLoad);
			const recovered = readRecovery(journalKey.current);
			if (recovered) {
				const mailbox = mailboxes.find(item => item.id === recovered.payload.mailboxId);
				if (!mailbox) { writeRecovery(journalKey.current, null); return; }
				if (mailbox.id !== selectedMailbox.id) setSelectedMailbox(mailbox);
				setLoadedDraftFrom(getEmailAddress(recovered.payload.from ?? "").toLowerCase());
				setDraftRestored(true);
				draftRequestId.current = recovered.requestId;
				savedDraftId.current = recovered.draftId;
				setDraftId(recovered.draftId);
				setTo(headerToRecipients(recovered.payload.to)); setCc(headerToRecipients(recovered.payload.cc)); setBcc(headerToRecipients(recovered.payload.bcc));
				setShowCc(!!recovered.payload.cc); setShowBcc(!!recovered.payload.bcc);
				setSubject(recovered.payload.subject ?? "");
				const body = splitQuotedHtml(recovered.payload.html ?? ""); setHtml(body.body); setQuotedHtml(body.quoted);
				setThreading({ inReplyTo: recovered.payload.inReplyTo ?? null, references: recovered.payload.references ?? null, threadId: recovered.payload.threadId ?? null });
				return;
			}
		}
		const bodyContent = htmlToPlainText(html).trim();
		const hasContent = to.length || cc.length || bcc.length || subject.trim() || quotedHtml || (bodyContent && bodyContent !== (selectedMailbox.signature?.trim() ?? ""));
		if (!fromAddr) return;
		if (!hasContent && !savedDraftId.current && !creationStarted.current) { dirtyDraft.current = false; setDraftSaving(false); writeRecovery(journalKey.current, null); return; }
		draftRequestId.current ??= crypto.randomUUID();
		const requestId = draftRequestId.current;
		const payload: DraftPayload = { mailboxId: selectedMailbox.id, from: fromAddr, to: recipientsToHeader(to), cc: recipientsToHeader(cc), bcc: recipientsToHeader(bcc), subject,
			html: joinQuotedHtml(html, quotedHtml), text: htmlToPlainText(joinQuotedHtml(html, quotedHtml)),
			inReplyTo: threading?.inReplyTo ?? null, references: threading?.references ?? null, threadId: threading?.threadId ?? null, requestId };
		const generation = draftGeneration.current;
		const session = getClientSessionToken();
		const journal = { payload, draftId: savedDraftId.current, requestId, savedAt: Date.now() };
		dirtyDraft.current = true; setDraftSaving(true);
		writeRecovery(journalKey.current, journal);
		let queued = false;
		const save = () => {
			if (queued) return;
			queued = true;
			saveChain.current = saveChain.current.then(async () => {
				if (generation !== draftGeneration.current || session !== getClientSessionToken()) return;
				const id = savedDraftId.current;
				if (!id) creationStarted.current = true;
				try {
					const res = await authFetch(id ? `/api/drafts/${id}` : "/api/drafts", { method: id ? "PATCH" : "POST", redirectOnUnauthorized: false, signal: AbortSignal.timeout(15000),
						headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
					const data = await res.json() as { draft?: { id: string; reused?: boolean } };
					if (!res.ok || !data.draft?.id) throw new Error("Draft save failed");
					if (session !== getClientSessionToken()) return;
					if (data.draft.reused) {
						const updated = await authFetch(`/api/drafts/${data.draft.id}`, { method: "PATCH", redirectOnUnauthorized: false, signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
						if (!updated.ok) throw new Error("Draft save failed");
					}
					if (generation !== draftGeneration.current) { void authFetch(`/api/drafts/${data.draft.id}`, { method: "DELETE" }).catch(() => {}); return; }
					savedDraftId.current = data.draft.id; setDraftId(data.draft.id); setDraftSaveFailed(false);
					if (flushSave.current === save) { dirtyDraft.current = false; setDraftSaving(false); writeRecovery(journalKey.current, null); }
					else { const latest = readRecovery(journalKey.current); if (latest) writeRecovery(journalKey.current, { ...latest, draftId: data.draft.id }); }
				} catch { queued = false; if (generation === draftGeneration.current) { setDraftSaveFailed(true); setDraftSaving(false); } }
			});
		};
		flushSave.current = save;
		saveTimer.current = setTimeout(save, 900);
		return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
	}, [bcc, cc, fromAddr, html, loadingDraft, quotedHtml, selectedMailbox?.id, selectedMailbox?.signature, subject, threading, to, draftIdToLoad, deletingDraft]);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (refineActive || loading) return;
		if (to.length === 0) {
			setToast({ type: "error", message: t("compose.error.noRecipient") });
			return;
		}
		const invalid = [...to, ...cc, ...bcc].find((entry) => !isValidRecipient(entry));
		if (invalid) {
			setToast({ type: "error", message: t("compose.error.invalidAddress", { address: invalid }) });
			return;
		}
		if (!hasMeaningfulHtml(html) && !quotedHtml) {
			setToast({ type: "error", message: t("compose.error.emptyBody") });
			return;
		}
		setLoading(true);
		const fullHtml = joinQuotedHtml(html, quotedHtml);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		if (dirtyDraft.current) flushSave.current?.();
		await saveChain.current;
		const currentDraftId = savedDraftId.current ?? draftId;
		if (currentDraftId && agentRevision !== null) {
			try {
				if (saveTimer.current) clearTimeout(saveTimer.current);
				if (attachments.length > 0) {
					const form = new FormData();
					for (const attachment of attachments) form.append("attachments", attachment.file);
					const uploaded = await authFetch(`/api/drafts/${currentDraftId}/attachments`, { method: "POST", body: form });
					const result = await uploaded.json() as { attachments?: ComposeStoredAttachment[]; error?: string };
					if (!uploaded.ok) throw new Error(result.error || t("compose.error.draftAttachments"));
					setStoredAttachments((current) => [...current, ...(result.attachments ?? [])]);
					setAttachments([]);
				}
				const updated = await authFetch(`/api/drafts/${currentDraftId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: selectedMailbox?.id, from: fromAddr, to: recipientsToHeader(to), cc: recipientsToHeader(cc), bcc: recipientsToHeader(bcc), subject, html: fullHtml, text: htmlToPlainText(fullHtml), inReplyTo: threading?.inReplyTo ?? null, references: threading?.references ?? null, threadId: threading?.threadId ?? null, scheduledAt: scheduledAt?.toISOString() ?? null }) });
				if (!updated.ok) throw new Error(t("compose.error.saveForReview"));
				const current = await fetchDraft(currentDraftId);
				if (!current.agent) throw new Error(t("compose.error.aiMetadata"));
				setAgentRevision(current.agent.revision);
				const response = await authFetch("/api/agent/approvals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: currentDraftId, expectedRevision: current.agent.revision }) });
				const result = await response.json() as { approvalId?: string; snapshot?: ReviewSnapshot; error?: string };
				if (!response.ok || !result.approvalId || !result.snapshot) throw new Error(result.error || t("compose.error.createReview"));
				setAgentReview({ approvalId: result.approvalId, snapshot: result.snapshot });
			} catch (cause) { setToast({ type: "error", message: cause instanceof Error ? cause.message : t("compose.error.reviewDraft") }); }
			finally { setLoading(false); }
			return;
		}
		try {
			const res = await authFetch("/api/send", {
				method: "POST",
				body: buildSendFormData({
					attachments,
					from: fromAddr,
					to: recipientsToHeader(to),
					cc: recipientsToHeader(cc),
					bcc: recipientsToHeader(bcc),
					subject,
					text: htmlToPlainText(fullHtml),
					html: fullHtml,
					mailboxId: selectedMailbox?.id,
					threading: threading ?? undefined,
					draftId: currentDraftId,
					scheduledAt,
				}),
			});
			const data = (await res.json()) as { messageId?: string; scheduled?: boolean; error?: string };

			if (!res.ok) {
				setToast({ type: "error", message: data.error ?? t("compose.error.sendFailed") });
				return;
			}

			if (saveTimer.current) clearTimeout(saveTimer.current);
			draftGeneration.current += 1;
			flushSave.current = null; dirtyDraft.current = false; writeRecovery(journalKey.current, null); draftRequestId.current = null; savedDraftId.current = null; creationStarted.current = false;
			setDraftSaveFailed(false);
			if (currentDraftId) {
				void authFetch(`/api/drafts/${currentDraftId}`, { method: "DELETE" }).catch(() => {}).finally(() => {
					window.dispatchEvent(new Event("mailflare:messages-changed"));
				});
			}
			setDraftId(null);
			setTo([]);
			setCc([]);
			setBcc([]);
			setShowCc(false);
			setShowBcc(false);
			setThreading(null);
			setStoredAttachments([]);
			setSubject("");
			setHtml(applyMailboxSignatureHtml("", "", selectedMailbox?.signature));
			setQuotedHtml(null);
			setAttachments([]);
			setScheduledAt(null);
			setToast({ type: "success", message: data.scheduled ? t("compose.scheduled") : t("compose.sent") });
			window.dispatchEvent(new Event("mailflare:messages-changed"));
		} catch {
			setToast({ type: "error", message: t("compose.error.sendFailed") });
		} finally {
			setLoading(false);
		}
	}

	async function deleteDraftAndClose() {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		setDeletingDraft(true);
		await saveChain.current;
		const id = savedDraftId.current ?? draftId;
		try {
			if (id) {
				const res = await authFetch(`/api/drafts/${id}`, { method: "DELETE", redirectOnUnauthorized: false, signal: AbortSignal.timeout(15000) });
				if (!res.ok) throw new Error("Draft deletion failed");
			}
		} catch {
			setDeletingDraft(false);
			setToast({ type: "error", message: t("compose.error.deleteDraft") });
			return;
		}
		draftGeneration.current += 1;
		flushSave.current = null; dirtyDraft.current = false; writeRecovery(journalKey.current, null); draftRequestId.current = null; savedDraftId.current = null; creationStarted.current = false;

		setDraftId(null);
		setTo([]);
		setCc([]);
		setBcc([]);
		setShowCc(false);
		setShowBcc(false);
		setThreading(null);
		setStoredAttachments([]);
		setSubject("");
		setHtml(applyMailboxSignatureHtml("", "", selectedMailbox?.signature));
		setQuotedHtml(null);
		setAttachments([]);
		setScheduledAt(null);
		window.dispatchEvent(new Event("mailflare:messages-changed"));

		if (onClose) {
			onClose();
			return;
		}
		setDeletingDraft(false);
		router.push("/inbox");
	}

	async function removeStoredAttachment(attachmentId: string) {
		if (!draftId) return;
		const res = await authFetch(`/api/drafts/${draftId}/attachments/${attachmentId}`, { method: "DELETE" });
		if (!res.ok) {
			setToast({ type: "error", message: t("compose.error.removeAttachment") });
			return;
		}
		setStoredAttachments((current) => current.filter((item) => item.id !== attachmentId));
	}

	function addAttachments(files: FileList | null) {
		if (!files) return;
		const nextFiles = Array.from(files);
		const nextCount = storedAttachments.length + attachments.length + nextFiles.length;
		const totalSize =
			storedAttachments.reduce((total, item) => total + item.size, 0) +
			[...attachments.map((attachment) => attachment.file), ...nextFiles].reduce(
				(total, file) => total + file.size,
				0,
			);

		if (nextCount > 10) {
			setToast({ type: "error", message: t("compose.error.maxAttachments") });
			return;
		}
		if (nextFiles.some((file) => file.size > attachmentPolicy.maxMb * 1_000_000)) {
			setToast({ type: "error", message: t("compose.error.attachmentSize", { max: attachmentPolicy.maxMb }) });
			return;
		}
		if (totalSize > attachmentPolicy.maxMb * 1_000_000) {
			setToast({ type: "error", message: t("compose.error.totalSize", { max: attachmentPolicy.maxMb }) });
			return;
		}

		setAttachments((current) => [
			...current,
			...nextFiles.map((file) => ({ id: crypto.randomUUID(), file })),
		]);
		if (attachmentInput.current) attachmentInput.current.value = "";
	}

	function onFileDragEnter(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		fileDragDepth.current += 1;
		if (!loading && !loadingDraft) setDraggingFiles(true);
	}

	function onFileDragOver(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = loading || loadingDraft ? "none" : "copy";
	}

	function onFileDragLeave(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
		if (fileDragDepth.current === 0) setDraggingFiles(false);
	}

	function onFileDrop(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		fileDragDepth.current = 0;
		setDraggingFiles(false);
		if (!loading && !loadingDraft) addAttachments(event.dataTransfer.files);
	}

	function selectSender(value: string) {
		const option = senderOptions.find((item) => `${item.mailbox.id}|${item.address}` === value);
		if (!option) return;
		setSelectedFrom(option.address);
		if (selectedMailbox?.id !== option.mailbox.id) setSelectedMailbox(option.mailbox);
	}

	const attachmentContent = (attachments.length > 0 || storedAttachments.length > 0) && (
		<div>
		<div className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto overflow-y-hidden px-3 py-2">
			{storedAttachments.map((attachment) => (
				<div
					key={attachment.id}
					className="flex max-w-full shrink-0 items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1 text-xs"
					title={t("compose.carriedOver")}
				>
					<FileText className="h-4 w-4 shrink-0 text-neutral-500" />
					<span className="max-w-48 truncate">{attachment.filename}</span>
					<span className="text-xs text-neutral-400">{formatAttachmentSize(attachment.size)}</span>
					<button
						type="button"
						onClick={() => void removeStoredAttachment(attachment.id)}
						className="rounded-full p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
					>
						<X className="h-3.5 w-3.5" />
						<span className="sr-only">{t("compose.removeAttachment")}</span>
					</button>
				</div>
			))}
			{attachments.map((attachment) => (
				<div
					key={attachment.id}
					className="flex max-w-full shrink-0 items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1 text-xs"
				>
					<FileText className="h-4 w-4 shrink-0 text-neutral-500" />
					<span className="max-w-48 truncate font-medium">{attachment.file.name}</span>
					<span className="text-xs text-neutral-400">
						{formatAttachmentSize(attachment.file.size)}
					</span>
					<button
						type="button"
						onClick={() =>
							setAttachments((current) =>
								current.filter((item) => item.id !== attachment.id),
							)
						}
						className="rounded-full p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
					>
						<X className="h-3.5 w-3.5" />
						<span className="sr-only">{t("compose.removeAttachment")}</span>
					</button>
				</div>
			))}
		</div>
		<p className="px-3 pb-2 text-xs text-amber-700">{[...attachments.map((item) => item.file.size), ...storedAttachments.map((item) => item.size)].some((size) => size > attachmentPolicy.cloudThresholdBytes) ? t("compose.cloudWarning.will") : t("compose.cloudWarning.may")}</p>
		</div>
	);

	const refineReplyContext = useMemo(() => ({
		mailboxId: loadedDraftMailboxId ?? selectedMailbox?.id,
		threadId: threading?.threadId ?? undefined,
		inReplyTo: threading?.inReplyTo ?? undefined,
		// The stored conversation is authoritative; quoted text covers imported/forwarded mail.
		quotedText: !threading?.threadId && !threading?.inReplyTo && quotedHtml ? htmlToPlainText(quotedHtml).trim() : undefined,
		subject, from: fromAddr, to: recipientsToHeader(to), cc: recipientsToHeader(cc),
	}), [loadedDraftMailboxId, selectedMailbox?.id, threading, quotedHtml, subject, fromAddr, to, cc]);

	const frameClass =
		mode === "popup"
			? minimized
				? "compose-minimized fixed bottom-0 right-4 z-40 flex h-11 md:right-8 md:h-9 w-[min(260px,calc(100vw-32px))] flex-col overflow-hidden rounded-t-2xl border border-neutral-200 bg-white shadow-2xl"
				: modalMode
				? "compose-popup fixed left-1/2 top-1/2 z-50 flex h-[86dvh] w-[min(860px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
				: "compose-popup fixed bottom-0 right-8 z-40 flex h-[min(640px,calc(100dvh-88px))] w-[min(600px,calc(100vw-32px))] flex-col overflow-hidden rounded-t-2xl border border-neutral-200 bg-white shadow-2xl"
			: "compose-page relative flex h-full min-h-0 md:min-h-[560px] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm";

	return (
		<>
			{agentReview && <SendReview approvalId={agentReview.approvalId} snapshot={agentReview.snapshot} onClose={() => setAgentReview(null)} onSent={() => { draftGeneration.current += 1; flushSave.current = null; dirtyDraft.current = false; writeRecovery(journalKey.current, null); setAgentReview(null); if (onClose) onClose(); else router.push("/sent"); }} />}
			{mode === "popup" && !minimized && <div data-compose-layer className="compose-touch-backdrop fixed inset-0 z-[39] hidden bg-white" aria-hidden="true" />}
			{mode === "popup" && modalMode && !minimized && <div data-compose-layer className="fixed inset-0 z-40 bg-neutral-950/65" aria-hidden="true" />}
			{toast && (
				<div
					className={cn(
						"fixed right-4 top-6 z-[60] max-w-[calc(100vw-32px)] rounded-lg px-4 py-3 text-sm font-medium shadow-lg",
						toast.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white",
					)}
				>
					{toast.message}
				</div>
			)}
			<form ref={frameRef} onSubmit={onSubmit} className={frameClass} role={modalMode && !minimized ? "dialog" : undefined} aria-modal={modalMode && !minimized || undefined} aria-label={modalMode && !minimized ? t("compose.dialogLabel") : undefined} onKeyDown={(event) => { if (modalMode && !minimized && event.key === "Escape") { event.preventDefault(); setModalMode(false); } }} onDragEnterCapture={minimized ? undefined : onFileDragEnter} onDragOverCapture={minimized ? undefined : onFileDragOver} onDragLeaveCapture={minimized ? undefined : onFileDragLeave} onDropCapture={minimized ? undefined : onFileDrop}>
				{draggingFiles && !minimized && (
					<div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 text-sm font-medium text-blue-700" aria-hidden="true">
						{t("compose.dropFiles")}
					</div>
				)}
				<div className="compose-header flex min-h-11 shrink-0 items-center justify-between bg-[#f0f4f9] px-4 text-sm font-medium text-neutral-800">
					<span className="flex min-w-0 items-center gap-2 truncate  dark:text-neutral-900">
						{threading?.inReplyTo && <Reply className="h-3.5 w-3.5 text-neutral-600" />}
						{!threading?.inReplyTo && /^fwd?:/i.test(subject) && <Forward className="h-3.5 w-3.5 text-neutral-600" />}
						{loadingDraft
							? t("compose.title.loading")
							: threading?.inReplyTo
								? t("compose.title.reply")
								: /^fwd?:/i.test(subject)
									? t("compose.title.forward")
									: draftId
										? t(draftSaving ? "common.saving" : draftSaveFailed ? "compose.title.new" : "compose.title.saved")
										: t("compose.title.new")}
					</span>
					{mode === "popup" && (
						<div className="flex shrink-0 items-center gap-1 md:gap-0 text-neutral-600">
							<button type="button" onClick={() => { setMinimized((current) => !current); setDraggingFiles(false); }} aria-label={minimized ? t("compose.restore") : t("compose.minimize")} title={minimized ? t("compose.restore") : t("compose.minimize")} className="flex h-11 w-11 items-center justify-center rounded hover:bg-neutral-200/60 md:h-8 md:w-8 dark:hover:bg-neutral-200 hover:text-neutral-900">
								{minimized ? <ChevronUp className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
							</button>
							<button type="button" onClick={() => { if (minimized) setMinimized(false); setModalMode((current) => !current); }} aria-label={modalMode ? t("compose.restoreFloating") : t("compose.openModal")} title={modalMode ? t("compose.restoreFloating") : t("compose.openModal")} className="hidden h-8 w-8 items-center justify-center rounded dark:hover:bg-neutral-200 hover:bg-neutral-200/60 hover:text-neutral-900 md:flex">
								{modalMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
							</button>
							<button type="button" onClick={() => { if (saveTimer.current) clearTimeout(saveTimer.current); if (dirtyDraft.current) flushSave.current?.(); onClose?.(); }} aria-label={t("compose.close")} className="flex h-11 w-11 items-center justify-center rounded hover:bg-neutral-200/60 md:h-8 md:w-8 dark:hover:bg-neutral-200 hover:text-neutral-900">
								<X className="h-4 w-4" />
							</button>
						</div>
					)}
				</div>
				<div className={cn("flex min-h-0 flex-1 flex-col", minimized && "hidden")}>
				{draftRestored && <p role="status" className="px-4 py-2 text-sm">{t("compose.recoveredText")}</p>}
				{draftSaveFailed && <p role="alert" className="shrink-0 bg-red-50 px-4 py-2 text-sm text-red-700">{t("compose.error.saveDraft")} <button type="button" className="underline" onClick={() => { setDraftSaving(true); flushSave.current?.(); }}>{t("message.retry")}</button></p>}
				<div className="max-h-[45%] shrink-0 overflow-y-auto overscroll-contain">
				<div className={cn(addressRowClassName, "compose-from-row")}>
					<Label htmlFor={`${mode}-from`} className={addressLabelClassName}>{t("compose.from")}</Label>
					<div className={cn(addressChipClassName, "relative max-w-[calc(100%-2.5rem)] rounded-md border-transparent bg-transparent px-0 text-neutral-600 focus-within:ring-2 focus-within:ring-blue-500", (loadingDraft || senderOptions.length === 0) && "opacity-50")}>
						<span aria-hidden="true" className="truncate">{selectedFrom || t("compose.selectMailboxFirst")}</span>
						<ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-neutral-400" />
						{/* Keep the native sender picker on iOS, with a full row-height touch target. */}
						<select
							id={`${mode}-from`}
							value={selectedMailbox && selectedFrom ? `${selectedMailbox.id}|${selectedFrom}` : ""}
							onChange={(event) => selectSender(event.target.value)}
							required
							disabled={loadingDraft || senderOptions.length === 0}
							title={selectedFrom}
							className="absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-pointer text-base opacity-0 disabled:cursor-not-allowed md:h-9 md:text-sm"
						>
							{senderOptions.length === 0 && <option value="">{t("compose.selectMailboxFirst")}</option>}
							{senderOptions.map(({ mailbox, address }) => (
								<option key={`${mailbox.id}|${address}`} value={`${mailbox.id}|${address}`}>{address}</option>
							))}
						</select>
					</div>
				</div>
				<RecipientInput
					id={`${mode}-to`}
					label={t("compose.to")}
					value={to}
					onChange={setTo}
					placeholder={t("compose.toPlaceholder")}
					required
					disabled={loadingDraft}
					trailing={
						<>
							{!showCc && (
								<button type="button" className="min-h-9 min-w-9 rounded px-1 hover:text-neutral-800 md:min-h-7" onClick={() => setShowCc(true)}>
									{t("compose.cc")}
								</button>
							)}
							{!showBcc && (
								<button type="button" className="min-h-9 min-w-9 rounded px-1 hover:text-neutral-800 md:min-h-7" onClick={() => setShowBcc(true)}>
									{t("compose.bcc")}
								</button>
							)}
						</>
					}
				/>
				{showCc && (
					<RecipientInput
						id={`${mode}-cc`}
						label={t("compose.cc")}
						value={cc}
						onChange={setCc}
						placeholder={t("compose.ccPlaceholder")}
						disabled={loadingDraft}
						autoFocus={!loadingDraft && cc.length === 0}
					/>
				)}
				{showBcc && (
					<RecipientInput
						id={`${mode}-bcc`}
						label={t("compose.bcc")}
						value={bcc}
						onChange={setBcc}
						placeholder={t("compose.bccPlaceholder")}
						disabled={loadingDraft}
						autoFocus={!loadingDraft && bcc.length === 0}
					/>
				)}
				<div className="border-b border-neutral-100 px-4 py-1">
					<Label htmlFor={`${mode}-subject`} className="sr-only">{t("compose.subject")}</Label>
					<Input
						id={`${mode}-subject`}
						value={subject}
						onChange={(event) => setSubject(event.target.value)}
						placeholder={t("compose.subject")}
						required
						disabled={loadingDraft}
						className="h-9 border-0 px-0 py-1 text-base md:h-8 md:text-sm shadow-none focus-visible:ring-0"
					/>
				</div>
				</div>
				<Label htmlFor={`${mode}-text`} className="sr-only">{t("compose.body")}</Label>
				<RichTextEditor
					id={`${mode}-text`}
					mailboxId={selectedMailbox?.id}
					value={html}
					onChange={setHtml}
					onRefineActiveChange={setRefineActive}
					quotedHtml={quotedHtml}
					replyContext={refineReplyContext}
					disabled={loadingDraft}
					placeholder={t("compose.bodyPlaceholder")}
					footerContent={attachmentContent}
					toolbarStart={
						<>
							<div className="flex items-center">
								<Button
									type="submit"
									size="sm"
									disabled={loading || loadingDraft || refineActive || !fromAddr}
									className="h-11 rounded-l-full rounded-r-none px-3 text-sm md:h-9 md:px-4"
								>
									{loading ? t("compose.preparing") : scheduledAt ? t("compose.schedule") : agentRevision !== null ? t("compose.reviewSend") : t("compose.send")}
								</Button>
								<ScheduleSendMenu
									disabled={loading || loadingDraft || refineActive || !fromAddr}
									value={scheduledAt}
									onChange={setScheduledAt}
									mailboxId={selectedMailbox?.id}
									from={fromAddr}
									onApplyTemplate={({ title, html: templateHtml }) => {
										setSubject((current) => current.trim() ? current : title);
										setHtml((current) => (hasMeaningfulHtml(current) ? `${current}${templateHtml}` : templateHtml));
									}}
								/>
							</div>
						</>
					}
					toolbarAttachment={
						<>
							<Input
								ref={attachmentInput}
								type="file"
								multiple
								className="hidden"
								onChange={(event) => addAttachments(event.target.files)}
							/>
							<Tooltip label={t("compose.attachTooltip", { max: attachmentPolicy.maxMb })}>
								<button
									type="button"
									aria-label={t("compose.attachFiles")}
									onClick={() => attachmentInput.current?.click()}
									disabled={loading || loadingDraft}
									className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 md:h-9 md:w-9 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-50"
								>
									<Paperclip className="h-4 w-4" />
								</button>
							</Tooltip>
						</>}
     toolbarEnd={<>
							<span className="flex-1" />
							<Tooltip label={t("compose.deleteDraft")}>
								<button
									type="button"
									aria-label={t("compose.deleteDraft")}
									onClick={() => void deleteDraftAndClose()}
									disabled={loading || loadingDraft || deletingDraft}
									className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-red-50 md:h-9 md:w-9 hover:text-red-600 disabled:pointer-events-none disabled:opacity-50"
								>
									<Trash2 className="h-4 w-4" />
								</button>
							</Tooltip>
						</>
					}
				/>
				</div>
			</form>
		</>
	);
}
