export type ImportMailboxResult = {
	imported: number;
	skipped: number;
	errors: string[];
};

export type ImportMessageInput = {
	filename: string;
	raw: ArrayBuffer;
	metadata?: {
		read: boolean; starred: boolean; direction: "inbound" | "outbound";
		category: "primary" | "promotions" | "social" | "invoices" | "orders";
		date?: Date; sourceKey?: string;
		threadId?: string;
	};
};
