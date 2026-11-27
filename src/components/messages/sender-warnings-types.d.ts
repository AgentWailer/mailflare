export type SenderWarning =
	/** The sender's name is that of `knownAddress`, whom the owner writes to, but the address is another one. */
	| { kind: "nameOfKnownPerson"; name: string; knownAddress: string }
	/** The sender's display name is written as an address, and it is not the address the message comes from. */
	| { kind: "nameIsOtherAddress"; shown: string }
	/** The sender signs with the owner's own name from an address that is not theirs. */
	| { kind: "ownName"; name: string }
	/** The sender's address or domain reads like `like`, a known correspondent's, but is not the same. */
	| { kind: "lookalike"; like: string }
	/** Replies would go to a public mail provider's address instead of the sender's own. */
	| { kind: "replyElsewhere"; replyTo: string }
	/** A link shows one site as its text and leads to another. Only said alongside another warning. */
	| { kind: "deceptiveLink"; shown: string; target: string };

export type SenderFacts = {
	/** People the owner wrote to or keeps as contacts: never somebody who only wrote to the owner. */
	known: readonly { email: string; name: string | null }[];
	/** The owner's own addresses and the names they send under. */
	own: readonly string[];
	ownNames: readonly string[];
	/** Domains of the owner's mailboxes. */
	organisationDomains: readonly string[];
};

export type SenderCheckInput = {
	fromAddr: string;
	replyTo?: string | null;
	/** The message's HTML, to look for links that show one site and lead to another. */
	html?: string | null;
	facts: SenderFacts;
};
