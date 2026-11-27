import type { ContactSource } from "@/lib/email/address-types";

/** One address the composer may suggest, with what ranks it. Times are epoch milliseconds. */
export type RecipientCandidate = {
	email: string;
	name: string | null;
	/** Messages the owner sent to this address (To, Cc or Bcc). */
	sends: number;
	lastSentAt: number | null;
	/** Last time this address was seen in any mail, from the contacts table. */
	lastSeenAt: number | null;
	/** How the contact entry came to be; null when the address is only known from sent mail. */
	source: ContactSource | null;
};

export type RecipientDirectoryContact = {
	email: string;
	displayName: string | null;
	source: ContactSource;
	blocked: boolean;
	lastSeenAt: Date | number | null;
};

export type RecipientDirectorySentMessage = {
	toAddr: string | null;
	ccAddr: string | null;
	bccAddr: string | null;
	createdAt: Date | number | null;
};
