import { eq, or, isNull, inArray, lte, gt, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messages } from "@/db/schema";
import type { getDb } from "@/db";
import { labelCondition } from "@/lib/mail-sorting/labels";
import { isMailCategory, INBOX_CATEGORIES } from "@/lib/mail-sorting/categories";
import { buildSearchConditions } from "@/lib/search/conditions";
import { parseSearchQuery } from "@/lib/search/query-utils";
import { scheduledMessageCondition } from "@/lib/email/scheduled";

/** Shared by lists and background actions. Nonempty searches span all folders. */
export function messageListFilterConditions(db: ReturnType<typeof getDb>, params: URLSearchParams, timeZone: string): SQL[] {
	const direction = params.get("direction");
	const folderId = params.get("folderId");
	const status = params.get("status");
	const requestedCategory = params.get("category") ?? "primary";
	const query = params.get("q")?.trim();
	const title = params.get("title")?.trim();
	const read = params.get("read");
	const starred = params.get("starred");
	const snoozed = params.get("snoozed");
	const scheduled = params.get("scheduled");
	const searching = !!(query || title);
	const conditions: SQL[] = [];
	if (!searching && (direction === "inbound" || direction === "outbound")) {
		conditions.push(eq(messages.direction, direction));
	}
	if (!searching && folderId) {
		conditions.push(labelCondition(folderId));
	}
	if (!searching && status) {
		conditions.push(folderId && status === "received" ? inArray(messages.status,["received","archived"]) : eq(messages.status, status));
	}
	// Composer templates are stored as messages but never listed.
	if (searching || status !== "template") {
		conditions.push(ne(messages.status, "template"));
	}
	if (!searching && status === "received" && !folderId) {
		const category = requestedCategory;
		if (!isMailCategory(category)) throw new Error("Invalid category");
		conditions.push(category === "primary" && params.get("inboxPolicy") !== "primary_only" ? inArray(messages.category, INBOX_CATEGORIES) : eq(messages.category,category));
		if(category === "primary") conditions.push(isNull(messages.folderId));
		conditions.push(or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!);
	}
	if (!searching && starred === "true") {
		conditions.push(eq(messages.starred, true));
	}
	if (!searching && snoozed === "true") {
		conditions.push(eq(messages.status, "received"));
		conditions.push(isNull(messages.folderId));
		conditions.push(gt(messages.snoozedUntil, new Date()));
	}
	if (!searching && scheduled === "true") {
		conditions.push(scheduledMessageCondition(db));
	}
	if (read === "read") {
		conditions.push(eq(messages.read, true));
	}
	if (read === "unread") {
		conditions.push(eq(messages.read, false));
	}
	if (query || title) {
		if (!parseSearchQuery(query ?? "", timeZone).includeSpam) conditions.push(ne(messages.status, "spam"));
		// Operators (from:, has:attachment, before:) and free text go through the
		// full-text index; `title` is the legacy subject filter and is folded in.
		conditions.push(...buildSearchConditions(title ? `${query ?? ""} subject:"${title}"` : query ?? "", timeZone));
	}
	return conditions;
}
