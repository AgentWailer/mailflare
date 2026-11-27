import type { AttachmentContent } from "@/lib/email/attachment-types";
import { readFormDataBody, readJsonBody } from "@/lib/http/request";
import type { SendRequestPayload } from "./types";

const MAX_SEND_REQUEST_SIZE = 30 * 1024 * 1024;

function getOptionalFormValue(form: FormData, key: string): string | undefined {
	const value = form.get(key);
	return typeof value === "string" && value ? value : undefined;
}

export async function parseSendRequest(request: Request): Promise<SendRequestPayload> {
	if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
		return readJsonBody<SendRequestPayload>(request, MAX_SEND_REQUEST_SIZE);
	}

	const form = await readFormDataBody(request, MAX_SEND_REQUEST_SIZE);
	const attachments: AttachmentContent[] = [];
	for (const value of form.getAll("attachments")) {
		if (!(value instanceof File) || value.size === 0) continue;
		attachments.push({
			filename: value.name,
			type: value.type || "application/octet-stream",
			content: await value.arrayBuffer(),
			disposition: "attachment",
		});
	}

	return {
		from: String(form.get("from") ?? ""),
		to: String(form.get("to") ?? ""),
		cc: getOptionalFormValue(form, "cc"),
		bcc: getOptionalFormValue(form, "bcc"),
		inReplyTo: getOptionalFormValue(form, "inReplyTo"),
		references: getOptionalFormValue(form, "references"),
		threadId: getOptionalFormValue(form, "threadId"),
		draftId: getOptionalFormValue(form, "draftId"),
		scheduledAt: getOptionalFormValue(form, "scheduledAt"),
		undoSeconds: getOptionalFormValue(form, "undoSeconds"),
		subject: String(form.get("subject") ?? ""),
		text: getOptionalFormValue(form, "text"),
		html: getOptionalFormValue(form, "html"),
		mailboxId: getOptionalFormValue(form, "mailboxId"),
		attachments,
	};
}

/** The longest a message is held back for "undo send". */
export const MAX_UNDO_SECONDS = 120;

/**
 * The delivery time of a message sent with an undo window, on the server's
 * clock: a device with a wrong clock must neither lose the window nor hold the
 * message for hours. Null when no window was asked for or the value is not a
 * whole number of seconds within the limit.
 */
export function getUndoDeliveryTime(value: string | number | undefined, now = Date.now()): Date | null {
	if (value === undefined || value === "") return null;
	const seconds = typeof value === "number" ? value : /^\d{1,3}$/.test(value) ? Number(value) : NaN;
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_UNDO_SECONDS) return null;
	return new Date(now + seconds * 1000);
}
