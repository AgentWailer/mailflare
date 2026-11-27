export type SendWarning =
	/** `address` reads like `like` (a known correspondent's address or domain) but is neither. */
	| { kind: "lookalike"; address: string; like: string }
	/** People outside the organisation, at several domains, would see each other in To and Cc. */
	| { kind: "outsiders"; count: number; domains: number; addresses: string[] }
	/** The text says something is attached, but nothing is. */
	| { kind: "missingAttachment" }
	/** More recipients than are checked; only the first `checked` were looked at. */
	| { kind: "tooManyRecipients"; checked: number }
	/** The address book could not be read, so recipients were not compared with known addresses. */
	| { kind: "unchecked" };

export type SendWarningFacts = {
	/** Addresses the owner wrote to or keeps as contacts, lower-cased. Never senders only. */
	known: readonly string[];
	/** The owner's own addresses, lower-cased. */
	own: readonly string[];
	/** Domains of the owner's organisation (their mailbox domains, without public providers). */
	organisationDomains: readonly string[];
};

export type SendWarningInput = {
	to: readonly string[];
	cc: readonly string[];
	bcc: readonly string[];
	facts: SendWarningFacts;
	/** Addresses already visible to everyone on the message being answered or forwarded. */
	seen?: readonly string[];
	/** The text the owner wrote, without the quoted original. */
	bodyText?: string;
	hasAttachments?: boolean;
};
