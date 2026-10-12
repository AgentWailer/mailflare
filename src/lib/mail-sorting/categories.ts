export const MAIL_CATEGORIES = ["primary", "invoices", "promotions", "social", "orders"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];
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
	inboxProbability?: number;
	personalProbability?: number;
	securityProbability?: number;
	learningExamples?: number;
};
/** Primary list membership. Financial categories have their own views. */
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
		(!message.category || message.category === "primary") &&
		message.direction !== "outbound" &&
		(!message.snoozedUntil || new Date(message.snoozedUntil).getTime() <= Date.now())
	);
}

export function shouldNotifyMail(message:Parameters<typeof isPrimaryInboxMail>[0]):boolean {
 // Moving transactions to their own category must not suppress their existing alerts.
 return isPrimaryInboxMail({ ...message, category: message.category === "invoices" || message.category === "orders" ? "primary" : message.category }) && message.read !== true;
}
