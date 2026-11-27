import { INBOX_CATEGORIES } from "@/lib/mail-sorting/categories";
import { labelCondition } from "@/lib/mail-sorting/labels";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lte,
	lt,
	ne,
	not,
	or,
	sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { KEYWORD_DRAFT, KEYWORD_FLAGGED, KEYWORD_SEEN } from "./constants";
import { invalidArguments, unsupportedFilter } from "./errors";
import { normalizeMessageId } from "@/lib/email/threading";
import { decodeMailboxRef, roleToStatus } from "./ids";
import type { Comparator, Filter, FilterCondition, MailboxRef } from "./types";

/** The SQL predicate for "is in this JMAP Mailbox". */
export function mailboxRefCondition(ref: MailboxRef): SQL {
	const base = eq(messages.mailboxId, ref.mailboxId);
	if (ref.kind === "account") return base;
	if (ref.kind === "folder")
		return and(
			base,
			labelCondition(ref.folderId),
			not(inArray(messages.status, ["spam", "trash", "template"])),
		)!;
	if (ref.kind === "category")
		return and(
			base,
			eq(messages.category, ref.category),
			eq(messages.status, "received"),
			eq(messages.direction, "inbound"),
		)!;
	const status = roleToStatus(ref.role);
	if (ref.role === "inbox")
		return and(
			base,
			eq(messages.status, status),
			inArray(messages.category, INBOX_CATEGORIES),
			eq(messages.direction, "inbound"),
			isNull(messages.folderId),
			or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!,
		)!;
	if (ref.role === "sent")
		return and(
			base,
			inArray(messages.status, ["sent", "queued", "failed"]),
			isNull(messages.folderId),
		)!;
	return and(base, eq(messages.status, status), isNull(messages.folderId))!;
}

function keywordCondition(keyword: string, present: boolean): SQL {
	switch (keyword) {
		case KEYWORD_SEEN:
			return present
				? or(eq(messages.read, true), eq(messages.direction, "outbound"))!
				: and(eq(messages.read, false), eq(messages.direction, "inbound"))!;
		case KEYWORD_FLAGGED:
			return eq(messages.starred, present);
		case KEYWORD_DRAFT:
			return present
				? eq(messages.status, "draft")
				: ne(messages.status, "draft");
		default:
			// Unknown keywords are never set, so "has" matches nothing and "not" matches all.
			return present ? sql`0` : sql`1`;
	}
}

function likeEscape(value: string): string {
	return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

function likePattern(value: string): string {
	return `%${likeEscape(value)}%`;
}

/**
 * RFC 8621 §4.4.1 `header`: `[name]` means the header is present, `[name, value]`
 * that its value equals that string. Only the headers Mailflare keeps as columns
 * can be matched, and Message-IDs compare without their angle brackets because
 * inbound rows store them with and outbound rows without.
 */
function headerCondition(header: string[]): SQL {
	if (
		!Array.isArray(header) ||
		header.length < 1 ||
		header.length > 2 ||
		typeof header[0] !== "string"
	) {
		throw invalidArguments("header must be [name] or [name, value]");
	}
	const name = header[0].trim().toLowerCase();
	const value =
		header.length === 2 ? normalizeMessageId(String(header[1])) : null;
	switch (name) {
		case "message-id":
			if (header.length === 1) return isNotNull(messages.providerMessageId);
			return value
				? inArray(messages.providerMessageId, [value, `<${value}>`])
				: sql`0`;
		case "in-reply-to":
			if (header.length === 1) return isNotNull(messages.inReplyTo);
			return value
				? inArray(messages.inReplyTo, [value, `<${value}>`])
				: sql`0`;
		case "references":
			if (header.length === 1) return isNotNull(messages.references);
			// The column is the space-joined chain, so pad both sides to match whole ids only.
			return value
				? like(
						sql`' ' || coalesce(${messages.references}, '') || ' '`,
						`% ${likeEscape(value)} %`,
					)
				: sql`0`;
		default:
			throw unsupportedFilter(`Cannot filter on the ${header[0]} header`);
	}
}

/** What each RFC 8621 §4.4.1 FilterCondition property must hold. */
const CONDITION_FIELDS: Record<string, "string" | "date" | "size" | "boolean" | "ids" | "header"> = {
	inMailbox: "string",
	inMailboxOtherThan: "ids",
	before: "date",
	after: "date",
	minSize: "size",
	maxSize: "size",
	allInThreadHaveKeyword: "string",
	someInThreadHaveKeyword: "string",
	noneInThreadHaveKeyword: "string",
	hasKeyword: "string",
	notKeyword: "string",
	hasAttachment: "boolean",
	text: "string",
	from: "string",
	to: "string",
	cc: "string",
	bcc: "string",
	subject: "string",
	body: "string",
	header: "header",
};

/** Operators nested deeper than any client writes; past this the request is refused, not recursed into. */
const MAX_FILTER_DEPTH = 32;

/**
 * A client's condition, checked before any of it is used. A property with the
 * wrong type is `invalidArguments`; one Mailflare does not know is
 * `unsupportedFilter`, never ignored, because ignoring a condition widens the
 * result to every message. `null` means the client left the property unset.
 */
function checkCondition(raw: unknown): FilterCondition {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw invalidArguments("A filter condition must be an object");
	const condition: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (value === null || value === undefined) continue;
		const kind = Object.hasOwn(CONDITION_FIELDS, key) ? CONDITION_FIELDS[key] : undefined;
		if (!kind) throw unsupportedFilter(`Cannot filter on ${key}`);
		const valid =
			kind === "string" ? typeof value === "string"
			: kind === "date" ? typeof value === "string" && !Number.isNaN(new Date(value).getTime())
			: kind === "size" ? typeof value === "number" && Number.isFinite(value) && value >= 0
			: kind === "boolean" ? typeof value === "boolean"
			: kind === "ids" ? Array.isArray(value) && value.every((id) => typeof id === "string")
			: true; // header: headerCondition checks its own shape
		if (!valid) throw invalidArguments(`${key} has the wrong type`);
		condition[key] = value;
	}
	return condition as FilterCondition;
}

function conditionToSql(
	unchecked: FilterCondition,
	accessible: Set<string>,
): SQL[] {
	const condition = checkCondition(unchecked);
	const parts: SQL[] = [];
	if (condition.inMailbox !== undefined) {
		const ref = decodeMailboxRef(condition.inMailbox);
		if (!ref || !accessible.has(ref.mailboxId))
			throw invalidArguments(`Unknown mailbox ${condition.inMailbox}`);
		parts.push(mailboxRefCondition(ref));
	}
	if (condition.inMailboxOtherThan) {
		for (const id of condition.inMailboxOtherThan) {
			const ref = decodeMailboxRef(id);
			if (ref && accessible.has(ref.mailboxId))
				parts.push(not(mailboxRefCondition(ref)));
		}
	}
	if (condition.before)
		parts.push(lt(messages.createdAt, new Date(condition.before)));
	if (condition.after)
		parts.push(gte(messages.createdAt, new Date(condition.after)));
	if (condition.hasKeyword)
		parts.push(keywordCondition(condition.hasKeyword, true));
	if (condition.notKeyword)
		parts.push(keywordCondition(condition.notKeyword, false));
	if (condition.someInThreadHaveKeyword)
		parts.push(keywordCondition(condition.someInThreadHaveKeyword, true));
	if (condition.allInThreadHaveKeyword)
		parts.push(keywordCondition(condition.allInThreadHaveKeyword, true));
	if (condition.noneInThreadHaveKeyword)
		parts.push(keywordCondition(condition.noneInThreadHaveKeyword, false));
	if (condition.from)
		parts.push(like(messages.fromAddr, likePattern(condition.from)));
	if (condition.to)
		parts.push(like(messages.toAddr, likePattern(condition.to)));
	if (condition.cc)
		parts.push(like(messages.ccAddr, likePattern(condition.cc)));
	if (condition.bcc)
		parts.push(like(messages.bccAddr, likePattern(condition.bcc)));
	if (condition.subject)
		parts.push(like(messages.subject, likePattern(condition.subject)));
	if (condition.body)
		parts.push(
			or(
				like(messages.textBody, likePattern(condition.body)),
				like(messages.htmlBody, likePattern(condition.body)),
			)!,
		);
	if (condition.text) {
		const pattern = likePattern(condition.text);
		parts.push(
			or(
				like(messages.subject, pattern),
				like(messages.fromAddr, pattern),
				like(messages.toAddr, pattern),
				like(messages.ccAddr, pattern),
				like(messages.textBody, pattern),
				like(messages.snippet, pattern),
			)!,
		);
	}
	if (condition.header) parts.push(headerCondition(condition.header));
	if (condition.hasAttachment !== undefined) {
		const hasOne = exists(
			sql`(SELECT 1 FROM ${messageAttachments} WHERE ${messageAttachments.messageId} = ${messages.id} AND ${messageAttachments.disposition} = 'attachment')`,
		);
		parts.push(condition.hasAttachment ? hasOne : not(hasOne));
	}
	if (condition.minSize !== undefined)
		parts.push(
			gte(
				sql`length(coalesce(${messages.textBody}, '')) + length(coalesce(${messages.htmlBody}, ''))`,
				condition.minSize,
			),
		);
	if (condition.maxSize !== undefined)
		parts.push(
			lt(
				sql`length(coalesce(${messages.textBody}, '')) + length(coalesce(${messages.htmlBody}, ''))`,
				condition.maxSize,
			),
		);
	return parts;
}

/** FilterOperator trees become nested AND/OR/NOT; a bare condition is an AND of its fields. */
export function filterToSql(
	filter: Filter | null | undefined,
	accessible: Set<string>,
	depth = 0,
): SQL | undefined {
	if (filter === null || filter === undefined) return undefined;
	if (typeof filter !== "object" || Array.isArray(filter))
		throw invalidArguments("filter must be an object");
	if (depth > MAX_FILTER_DEPTH) throw invalidArguments("filter is nested too deeply");
	if ("operator" in filter) {
		if (!Array.isArray(filter.conditions))
			throw invalidArguments("conditions must be a list");
		const children = filter.conditions
			.map((child) => filterToSql(child, accessible, depth + 1))
			.filter((part): part is SQL => !!part);
		if (children.length === 0) return undefined;
		if (filter.operator === "AND") return and(...children);
		if (filter.operator === "OR") return or(...children);
		if (filter.operator === "NOT") return not(and(...children)!);
		throw invalidArguments(`Unknown operator ${String(filter.operator)}`);
	}
	const parts = conditionToSql(filter, accessible);
	return parts.length ? and(...parts) : undefined;
}

export function sortToSql(sort: Comparator[] | null | undefined): SQL[] {
	const comparators =
		sort && sort.length
			? sort
			: [{ property: "receivedAt", isAscending: false }];
	return comparators.map((item) => {
		const direction = item.isAscending ? asc : desc;
		switch (item.property) {
			case "receivedAt":
			case "sentAt":
				return direction(messages.createdAt);
			case "subject":
				return direction(messages.subject);
			case "from":
				return direction(messages.fromAddr);
			case "to":
				return direction(messages.toAddr);
			case "size":
				return direction(
					sql`length(coalesce(${messages.textBody}, '')) + length(coalesce(${messages.htmlBody}, ''))`,
				);
			case "hasKeyword":
			case "allInThreadHaveKeyword":
			case "someInThreadHaveKeyword": {
				const keyword =
					(item as Comparator & { keyword?: string }).keyword ?? KEYWORD_SEEN;
				return direction(
					keyword === KEYWORD_FLAGGED ? messages.starred : messages.read,
				);
			}
			default:
				throw invalidArguments(`Cannot sort by ${item.property}`);
		}
	});
}

export { gt };
