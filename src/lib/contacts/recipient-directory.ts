import { and, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { contacts, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { buildRecipientDirectory } from "./recipient-directory-utils";

/** Sent messages read for ranking: the most recent ones say who the owner writes to now. */
const SENT_MESSAGES_READ = 2_000;
/** Contacts read, most recently seen first. */
const CONTACTS_READ = 5_000;

export async function loadRecipientDirectory(db: ReturnType<typeof getDb>, user: Pick<SessionUser, "id" | "email" | "role">) {
	const [contactRows, sentRows, mailboxRows] = await Promise.all([
		db.select({ email: contacts.email, displayName: contacts.displayName, source: contacts.source, blocked: contacts.blocked, lastSeenAt: contacts.lastSeenAt })
			.from(contacts).where(eq(contacts.userId, user.id)).orderBy(desc(contacts.lastSeenAt)).limit(CONTACTS_READ),
		// Only what this user sent themselves; sent mail of a shared mailbox belongs to its sender.
		db.select({ toAddr: messages.toAddr, ccAddr: messages.ccAddr, bccAddr: messages.bccAddr, createdAt: messages.createdAt })
			.from(messages)
			.where(and(eq(messages.userId, user.id), eq(messages.direction, "outbound"), inArray(messages.status, ["sent", "queued", "sending"])))
			.orderBy(desc(messages.createdAt)).limit(SENT_MESSAGES_READ),
		listAccessibleMailboxes(db, user),
	]);
	const own = [user.email, ...mailboxRows.map((mailbox) => `${mailbox.localPart}@${mailbox.hostname}`)];
	return buildRecipientDirectory({ contacts: contactRows, sent: sentRows, own });
}
