import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import type { AttachmentPreviewKind } from "./message-attachment-viewer-types";
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
	if (attachment.type === "application/pdf") return "pdf";
	if (attachment.type.startsWith("audio/")) return "audio";
	if (attachment.type.startsWith("video/")) return "video";
	if (attachment.type.startsWith("image/") && attachment.type !== "image/svg+xml") return "image";
	if (
		attachment.type.startsWith("text/plain") ||
		attachment.type === "application/json" ||
		attachment.type === "application/xml" ||
		attachment.type === "text/csv"
	) {
		return "text";
	}
	return "unsupported";
}
