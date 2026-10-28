import { attachmentPreviewKind } from "@/lib/email/attachment-preview";

export function getAttachmentContentDisposition(filename: string, inline: boolean): string {
	const safeFilename = filename.replace(/["\\\r\n]/g, "_");
	return `${inline ? "inline" : "attachment"}; filename="${safeFilename}"`;
}

export function isPreviewableAttachmentType(contentType: string, filename?: string): boolean {
	return attachmentPreviewKind(contentType, filename) !== "unsupported";
}
