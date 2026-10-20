export interface AttachmentContent {
	content: ArrayBuffer;
	storageId?: string;
	contentId?: string | null;
	disposition?: "attachment" | "inline";
	filename: string;
	type: string;
}

/** File/Blob uploads can be stored without an additional JS ArrayBuffer copy. */
export type AttachmentStorageInput = Omit<AttachmentContent, "content"> & { content: ArrayBuffer | Blob };

export interface AttachmentMetadata {
	contentId: string | null;
	disposition: "attachment" | "inline";
	filename: string;
	id: string;
	messageId: string;
	size: number;
	type: string;
}

export interface StoredAttachment extends AttachmentMetadata {
	r2Key: string;
}
