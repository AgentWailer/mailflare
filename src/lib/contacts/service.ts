import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, routingRules } from "@/db/schema";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import type { BlockContactInput, ContactInput, MessageContactNames } from "@/lib/contacts/types";
import { getContactId, getContactNameFromAddress } from "@/lib/contacts/utils";
import { importGravatarAvatar } from "@/lib/contacts/gravatar";

export async function upsertContactFromAddress(env: CloudflareEnv, input: ContactInput) {
	const email = normalizeEmailAddress(input.address);
	if (!email) return null;

	const displayName = getContactNameFromAddress(input.address);
	const db = getDb(env);
	const [existing] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.userId, input.userId), eq(contacts.email, email)))
		.limit(1);
	const now = new Date();

	if (existing) {
		const nextDisplayName = getNextDisplayName(existing.displayName, existing.source, displayName);
		const nextSource = existing.source === "manual" || (existing.source === "outbound" && input.source === "inbound")
			? existing.source
			: input.source;

		await db
			.update(contacts)
			.set({
				displayName: nextDisplayName,
				source: nextSource,
				lastSeenAt: now,
			})
			.where(eq(contacts.id, existing.id));
		return { ...existing, displayName: nextDisplayName, source: nextSource, lastSeenAt: now };
	}

	const id = getContactId(input.userId, email);
	await db.insert(contacts).values({
		id,
		userId: input.userId,
		email,
		displayName,
		source: input.source,
		lastSeenAt: now,
	});
	const avatarKey = await importGravatarAvatar(env, input.userId, email);
	if (avatarKey) {
		await db.update(contacts).set({ avatarKey }).where(eq(contacts.id, id));
	}

	const [created] = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
	return created ?? null;
}

/** Only user-chosen names override message headers. Automatically collected
 * contacts can share an address across many people (for example LinkedIn), so
 * their latest name must never rename previously received messages. */
export async function getContactDisplayNameMap(env: CloudflareEnv, userId: string, addresses: string[]) {
	const emails = Array.from(new Set(addresses.map(normalizeEmailAddress).filter(Boolean)));
	if (emails.length === 0) return new Map<string, string>();

	const db = getDb(env);
	const names = new Map<string, string>();
	for (let offset = 0; offset < emails.length; offset += 80) {
		const rows = await db.select({ email: contacts.email, displayName: contacts.displayName }).from(contacts)
			.where(and(eq(contacts.userId, userId), eq(contacts.source, "manual"), inArray(contacts.email, emails.slice(offset, offset + 80))));
		for (const contact of rows) if (contact.displayName) names.set(contact.email, contact.displayName);
	}
	return names;
}

export async function getContactAvatarMap(env: CloudflareEnv, userId: string, addresses: string[]) {
	const emails = Array.from(new Set(addresses.map(normalizeEmailAddress).filter(Boolean)));
	if (emails.length === 0) return new Map<string, boolean>();

	const db = getDb(env);
	const avatars = new Map<string, boolean>();
	for (let offset = 0; offset < emails.length; offset += 80) {
		const rows = await db.select({ email: contacts.email, avatarKey: contacts.avatarKey }).from(contacts)
			.where(and(eq(contacts.userId, userId), inArray(contacts.email, emails.slice(offset, offset + 80))));
		for (const contact of rows) avatars.set(contact.email, !!contact.avatarKey);
	}
	return avatars;
}

export async function getMessageContactNames(
	env: CloudflareEnv,
	userId: string,
	fromAddr: string,
	toAddr: string,
): Promise<MessageContactNames> {
	// `toAddr` may be a full recipient list; the name shown belongs to the first one.
	const firstTo = getFirstEmailAddressEntry(toAddr);
	const contactMap = await getContactDisplayNameMap(env, userId, [fromAddr, firstTo]);

	return {
		fromContactName: contactMap.get(normalizeEmailAddress(fromAddr)) ?? null,
		toContactName: contactMap.get(normalizeEmailAddress(firstTo)) ?? null,
	};
}

export async function blockContact(env: CloudflareEnv, input: BlockContactInput) {
	const email = normalizeEmailAddress(input.address);
	if (!email) throw new Error("Contact email is required");

	const db = getDb(env);
	const contactId = getContactId(input.userId, email);
	const [existingContact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.userId, input.userId), eq(contacts.email, email)))
		.limit(1);
	if (existingContact) {
		await db.update(contacts).set({ blocked: true }).where(eq(contacts.id, existingContact.id));
	} else {
		await db.insert(contacts).values({
			id: contactId,
			userId: input.userId,
			email,
			displayName: getContactNameFromAddress(input.address),
			source: "inbound",
			blocked: true,
			lastSeenAt: new Date(),
		});
		const avatarKey = await importGravatarAvatar(env, input.userId, email);
		if (avatarKey) {
			await db.update(contacts).set({ avatarKey }).where(eq(contacts.id, contactId));
		}
	}

	const [existingRule] = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, input.mailboxId),
				eq(routingRules.matchField, "email"),
				eq(routingRules.matchOperator, "exact"),
				eq(routingRules.matchValue, email),
				eq(routingRules.action, "trash"),
			),
		)
		.limit(1);
	if (!existingRule) {
		await db.insert(routingRules).values({
			id: `block:${input.mailboxId}:${email}`,
			userId: input.userId,
			domainId: input.domainId,
			pattern: email,
			matchField: "email",
			matchOperator: "exact",
			matchValue: email,
			mailboxId: input.mailboxId,
			action: "trash",
			priority: 100,
		});
	}

	return { email, blocked: true };
}

function getNextDisplayName(existingName: string | null, source: string, nextName: string | null): string | null {
	if (source === "manual") return existingName;
	if (nextName) return nextName;
	return existingName;
}
