import type { MessageDragPayload } from "./drag-types";

export const MESSAGE_DRAG_MIME = "application/x-mailflare-message-ids";

export function hasMessageDragData(dataTransfer: DataTransfer): boolean {
	return Array.from(dataTransfer.types).includes(MESSAGE_DRAG_MIME);
}

export function setMessageDragData(dataTransfer: DataTransfer, payload: MessageDragPayload): void {
	dataTransfer.effectAllowed = "move";
	dataTransfer.setData(MESSAGE_DRAG_MIME, JSON.stringify(payload));
	dataTransfer.setData("text/plain", payload.messageIds.join(","));
}

export function getMessageDragData(dataTransfer: DataTransfer): MessageDragPayload | null {
	const raw = dataTransfer.getData(MESSAGE_DRAG_MIME);
	if (!raw) return null;

	try {
		const payload = JSON.parse(raw) as Partial<MessageDragPayload>;
		if (!payload || !Array.isArray(payload.messageIds)) return null;
		const messageIds = [...new Set(payload.messageIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
		return messageIds.length > 0 ? { messageIds } : null;
	} catch {
		return null;
	}
}
