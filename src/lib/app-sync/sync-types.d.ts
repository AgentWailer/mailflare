import type { messages } from "@/db/schema";

/** Where a device stands. `backfill` is set while the first sync still pages through the window. */
export type AppSyncCursor = {
	v: 1;
	seq: number;
	days: number;
	backfill: { createdAt: number; id: string } | null;
};

/** A list row: everything a message list draws, never bodies or storage keys. */
export type AppSyncMessage = Omit<typeof messages.$inferSelect, "textBody" | "htmlBody" | "headerMetadata" | "rawR2Key"> & {
	attachmentCount: number;
	labels: Array<{ id: string; name: string; color: string }>;
	fromContactName: string | null;
	toContactName: string | null;
};

export type AppSyncResponse = {
	/** Opaque; the device sends it back unchanged. */
	cursor: string;
	/** There is more to fetch right away. */
	more: boolean;
	/** The device must drop its mail and call again without a cursor. */
	reset: boolean;
	/** Every mailbox the user may read now. */
	mailboxIds: string[];
	messages: AppSyncMessage[];
	/** Messages to delete on the device. */
	removed: string[];
};

export type AppSyncOptions = {
	cursor: string | null;
	days: number;
	limit: number;
	now?: Date;
};
