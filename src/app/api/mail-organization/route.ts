import { executeOrganizationAction } from "@/lib/messages/organize-action";
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getMessageLabels } from "@/lib/mail-sorting/labels";

const selection = z.object({
	mailboxId: z.string().min(1),
	messageIds: z.array(z.string().min(1)).min(1).max(200),
});
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const query = new URL(request.url).searchParams;
	const parsed = selection.safeParse({
		mailboxId: query.get("mailboxId"),
		messageIds: query.getAll("messageId"),
	});
	if (!parsed.success)
		return NextResponse.json({ error: "Invalid selection" }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canRead)
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	const rows = (
		await loadSelectedMessages(
			db,
			parsed.data.mailboxId,
			parsed.data.messageIds,
		)
	).map((row) => ({
		id: row.id,
		category: row.category,
		status: row.status,
		folderId: row.folderId,
		sortingDecision: row.sortingDecision,
	}));
	if (rows.length !== new Set(parsed.data.messageIds).size)
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	const labels = await getMessageLabels(
		db,
		rows.map((row) => row.id),
	);
	return NextResponse.json({
		messages: rows.map((row) => ({
			...row,
			labels: labels
				.filter((label) => label.messageId === row.id)
				.map((label) => ({
					id: label.id,
					name: label.name,
					color: label.color,
				})),
		})),
		canManage: access.canManage,
	});
}

export async function POST(request: Request) {
	if (!hasValidSessionMutationOrigin(request))
		return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	return executeOrganizationAction(env, user, await request.json().catch(() => null));
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
