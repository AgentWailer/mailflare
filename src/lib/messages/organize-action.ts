import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getMessageLabels, validLabelIds } from "@/lib/mail-sorting/labels";
import { createCategoryCorrection } from "@/lib/mail-sorting/learning";
import { newId } from "@/lib/ids";
import { getEmailAddress } from "@/lib/email/address";
import { reviewText } from "@/lib/mail-sorting/content-review";

import type { SessionUser } from "@/lib/auth/types";
const selection = z.object({
	mailboxId: z.string().min(1),
	messageIds: z.array(z.string().min(1)).min(1).max(200),
});
const mutation = selection
	.extend({
		labelIds: z.array(z.string().min(1)).max(50).optional(),
		addLabelIds: z.array(z.string().min(1)).max(50).optional(),
		removeLabelIds: z.array(z.string().min(1)).max(50).optional(),
		category: z.enum(["primary", "promotions", "social", "invoices", "orders"]).optional(),
		skipInbox: z.boolean().optional(),
		rememberSender: z.boolean().default(false),
	})
	.refine(
		(value) =>
			value.labelIds !== undefined ||
			value.addLabelIds !== undefined ||
			value.removeLabelIds !== undefined ||
			value.category !== undefined ||
			value.skipInbox !== undefined,
	);

export async function executeOrganizationAction(env: CloudflareEnv, user: SessionUser, payload: unknown) {
	const parsed = mutation.safeParse(payload);
	if (!parsed.success)
		return NextResponse.json(
			{ error: "Invalid organization" },
			{ status: 400 },
		);
	const input = parsed.data;
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, input.mailboxId);
	if (!access?.canManage)
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	const ids = [...new Set(input.messageIds)];
	const rows = await loadSelectedMessages(db, input.mailboxId, ids);
	if (rows.length !== ids.length)
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	const labels =
		input.labelIds === undefined ? undefined : [...new Set(input.labelIds)];
	const requested = [
		...new Set([
			...(labels ?? []),
			...(input.addLabelIds ?? []),
			...(input.removeLabelIds ?? []),
		]),
	];
	if (
		(await validLabelIds(db, input.mailboxId, requested)).length !==
		requested.length
	)
		return NextResponse.json({ error: "Label not found" }, { status: 404 });
	if (
		input.rememberSender &&
		(!input.category || rows.some((row) => row.direction !== "inbound"))
	)
		return NextResponse.json(
			{ error: "Select a category for incoming mail" },
			{ status: 400 },
		);
	// D1 batch commits labels, membership and sender corrections together.
	const currentLabels = await getMessageLabels(db, ids);
	const statements: D1PreparedStatement[] = [];
	for (const row of rows) {
		const finalLabels =
			labels ??
			(input.addLabelIds || input.removeLabelIds
				? [
						...new Set([
							...currentLabels
								.filter((label) => label.messageId === row.id)
								.map((label) => label.id),
							...(input.addLabelIds ?? []),
						]),
					].filter((id) => !input.removeLabelIds?.includes(id))
				: undefined);
		if (finalLabels) {
			statements.push(
				env.DB.prepare("DELETE FROM message_labels WHERE message_id=?").bind(
					row.id,
				),
			);
			for (const label of finalLabels)
				statements.push(
					env.DB.prepare(
						"INSERT INTO message_labels(message_id,folder_id) VALUES (?,?)",
					).bind(row.id, label),
				);
		}
		const category = input.category ?? row.category;
		let status = row.status;
		if (input.skipInbox === true && status === "received") status = "archived";
		if (input.skipInbox === false && status === "archived") status = "received";
		// Correcting spam explicitly makes it readable again, without sending old-mail alerts.
		if (input.category && status === "spam")
			status = input.skipInbox ? "archived" : "received";
		const folderId =
			input.skipInbox === false ||
			input.category ||
			(finalLabels && row.folderId && !finalLabels.includes(row.folderId))
				? null
				: row.folderId;
		statements.push(
			env.DB.prepare(
				"UPDATE messages SET category=?,status=?,folder_id=?,sorting_decision=? WHERE id=? AND mailbox_id=?",
			).bind(
				category,
				status,
				folderId,
				input.category && row.direction === "inbound"
					? JSON.stringify(createCategoryCorrection(category, row.sortingDecision, user.id))
					: row.sortingDecision,
				row.id,
				input.mailboxId,
			),
		);
		if (input.category && row.direction === "inbound") {
			statements.push(env.DB.prepare(`INSERT INTO mail_sorting_feedback(id,mailbox_id,message_id,sender,subject,category,corrected_at,excerpt,source)
				VALUES(?,?,?,?,?,?,?,?, 'user') ON CONFLICT(mailbox_id,message_id) DO UPDATE SET category=excluded.category,corrected_at=excluded.corrected_at,excerpt=excluded.excerpt,source='user'`)
				.bind(newId("sfb"), input.mailboxId, row.id, getEmailAddress(row.fromAddr).trim().toLowerCase(), row.subject?.slice(0, 200) ?? "", input.category, new Date().toISOString(), reviewText({ text_body: row.textBody, html_body: row.htmlBody, snippet: row.snippet }).slice(0, 1000)));
		}
		if (input.rememberSender)
			statements.push(
				env.DB.prepare(
					"INSERT INTO mail_sorting_overrides(mailbox_id,sender,category) VALUES (?,?,?) ON CONFLICT(mailbox_id,sender) DO UPDATE SET category=excluded.category",
				).bind(
					input.mailboxId,
					getEmailAddress(row.fromAddr).trim().toLowerCase(),
					category,
				),
			);
	}
	await env.DB.batch(statements);
	return NextResponse.json({ ok: true });
}

async function loadSelectedMessages(
	db: ReturnType<typeof getDb>,
	mailboxId: string,
	ids: string[],
) {
	const rows: Array<typeof messages.$inferSelect> = [];
	for (let index = 0; index < ids.length; index += 80)
		rows.push(
			...(await db
				.select()
				.from(messages)
				.where(
					and(
						eq(messages.mailboxId, mailboxId),
						inArray(messages.id, ids.slice(index, index + 80)),
					),
				)),
		);
	return rows;
}
