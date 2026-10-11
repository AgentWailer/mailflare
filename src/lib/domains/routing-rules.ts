import { and, asc, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, routingRules } from "@/db/schema";
import { getDomainRegistryOwnerId } from "./access";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";

export type DomainRuleInput = {
	domainId: string;
	name?: string | null;
	enabled: boolean;
	matchField: "recipient" | "sender" | "title" | "content";
	matchOperator: "contains" | "exact" | "starts_with" | "ends_with" | "regex";
	matchValue: string;
	action: "store" | "forward" | "reject";
	mailboxId?: string | null;
	forwardTo?: string | null;
	keepCopy: boolean;
	rejectReason?: string | null;
	priority: number;
};

export async function listDomainRules(db: AppDatabase, domainId: string) {
	return db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.domainId, domainId), eq(routingRules.scope, "domain")))
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
}

export async function getManagedDomainMailbox(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "email" | "role">,
	mailboxId: string,
	domainId: string,
) {
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage || access.mailbox.domainId !== domainId) return null;
	return access.mailbox;
}

export async function listManagedDomainMailboxes(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "email" | "role">,
	domainId: string,
) {
	const accessible = await listAccessibleMailboxes(db, user);
	return accessible
		.filter((mailbox) => mailbox.domainId === domainId && mailbox.permission === "full_access")
		.map(({ id, localPart, displayName, disabled }) => ({ id, localPart, displayName, disabled }))
		.sort((a, b) => a.localPart.localeCompare(b.localPart));
}

export async function getAdminDomain(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "role" | "canManageMailboxes" | "createdByUserId">,
	domainId: string,
) {
	if (user.role !== "admin") return null;
	const ownerId = getDomainRegistryOwnerId(user);
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), eq(domains.userId, ownerId)))
		.limit(1);
	return domain ?? null;
}

export async function listAdminDomainMailboxes(db: AppDatabase, domainId: string) {
	const ownerId = await getDomainOwnerId(db, domainId);
	if (!ownerId) return [];
	return db
		.select({
			id: mailboxes.id,
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			disabled: mailboxes.disabled,
			hostname: domains.hostname,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(eq(domains.userId, ownerId))
		.orderBy(asc(domains.hostname), asc(mailboxes.localPart));
}

async function getDomainOwnerId(db: AppDatabase, domainId: string) {
	const [domain] = await db.select({ ownerId: domains.userId }).from(domains).where(eq(domains.id, domainId)).limit(1);
	return domain?.ownerId;
}

export async function assertAdminRuleMailbox(db: AppDatabase, mailboxId: string, domainId: string): Promise<boolean> {
	const ownerId = await getDomainOwnerId(db, domainId);
	if (!ownerId) return false;
	const [mailbox] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(and(eq(mailboxes.id, mailboxId), eq(domains.userId, ownerId)))
		.limit(1);
	return !!mailbox;
}

/** A rule can deliver only to an inbox that the caller can fully manage. */
export async function assertRuleMailbox(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "email" | "role">,
	mailboxId: string,
	domainId: string,
): Promise<boolean> {
	return !!(await getManagedDomainMailbox(db, user, mailboxId, domainId));
}

export function toRuleColumns(input: DomainRuleInput) {
	return {
		scope: "domain" as const,
		name: input.name?.trim() || null,
		enabled: input.enabled,
		pattern: input.matchValue,
		matchField: input.matchField,
		matchOperator: input.matchOperator,
		matchValue: input.matchValue,
		action: input.action,
		mailboxId: input.action === "reject" ? null : (input.mailboxId ?? null),
		folderId: null,
		forwardTo: input.action === "forward" ? (input.forwardTo?.trim() ?? null) : null,
		keepCopy: input.action === "forward" ? input.keepCopy : false,
		rejectReason: input.action === "reject" ? (input.rejectReason?.trim() || null) : null,
		priority: input.priority,
	};
}
