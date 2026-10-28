export const MAIL_CATEGORIES = ["primary", "invoices", "promotions", "social", "orders"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];
/** Categories are additional views, not automatic moves out of the inbox. */
export const INBOX_CATEGORIES = ["primary", "invoices", "orders", "social"] as const;
export function isMailCategory(value: unknown): value is MailCategory {
	return MAIL_CATEGORIES.includes(value as MailCategory);
}
export type SortingDecision = {
	category: MailCategory;
	source: "clef" | "override" | "fallback" | "rule";
	reason: string;
	probabilities?: Record<string, number>;
	suggestedCategory?: string;
	spam?: boolean;
	reviewRequired?: boolean;
	fallbackReason?: string;
	policyVersion?: number;
	/** Requested Workers AI model, recorded only when a model was evaluated. */
	model?: string;
	inboxProbability?: number;
	personalProbability?: number;
	securityProbability?: number;
	marketingProbability?: number;
	learningExamples?: number;
};
/** Inbox membership; explicit archive/move/snooze actions still take precedence. */
export function isPrimaryInboxMail(message: {
	status: string;
	folderId?: string | null;
	category?: string | null;
	direction?: string;
	read?: boolean;
	snoozedUntil?:Date|string|null;
}): boolean {
	return (
		message.status === "received" &&
		!message.folderId &&
		(!message.category || INBOX_CATEGORIES.includes(message.category as (typeof INBOX_CATEGORIES)[number])) &&
		message.direction !== "outbound" &&
		(!message.snoozedUntil || new Date(message.snoozedUntil).getTime() <= Date.now())
	);
}

export function shouldNotifyMail(message:Parameters<typeof isPrimaryInboxMail>[0]):boolean {
 // Keep social notifications quiet while displaying them in the inbox.
 return isPrimaryInboxMail(message) && message.category !== "social" && message.read !== true;
}
