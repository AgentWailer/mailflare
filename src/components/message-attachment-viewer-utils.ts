import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import type { AttachmentPreviewKind } from "./message-attachment-viewer-types";
import { attachmentPreviewKind } from "@/lib/email/attachment-preview";
import { isWalletPass } from "@/lib/email/wallet-pass";

export function getAttachmentFileUrl(
	messageId: string,
	attachmentId: string,
	mode: "download" | "preview" | "open" = "download",
): string {
	const suffix = mode === "open" ? "?open=1" : mode === "preview" ? "?preview=1" : "?download=1";
	return `/api/messages/${messageId}/attachments/${attachmentId}${suffix}`;
}

export function getAttachmentPreviewKind(
	attachment: Pick<MessageAttachment, "type"> & Partial<Pick<MessageAttachment, "filename">>,
): AttachmentPreviewKind {
	if (isWalletPass(attachment.type, attachment.filename)) return "wallet";
	return attachmentPreviewKind(attachment.type, attachment.filename);
}
