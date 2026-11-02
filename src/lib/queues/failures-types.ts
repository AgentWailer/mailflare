export type QueueFailureKind = "inbound" | "outbound" | "backup" | "gmail" | "import" | "sort" | "paperless" | "audit" | "bulk" | "agent" | "webhook" | "unknown";

export type QueueFailureNotice = {
	kind: QueueFailureKind;
	category: string;
	attempts: number;
	createdAt: string;
};

export type QueueFailureStatus = {
	/** Capped number of recorded notifications, never a live DLQ message count. */
	count: number;
	hasMore: boolean;
	since: string;
	recent: QueueFailureNotice[];
};
