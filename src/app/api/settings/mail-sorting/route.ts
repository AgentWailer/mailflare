import { getSortingExamples } from "@/lib/mail-sorting/learning";
import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
	mailboxSortingSettings,
	mailSortingUsage,
	mailSortingOverrides,
} from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import {
	DEFAULT_SORTING_SETTINGS,
	SORTING_MODEL,
} from "@/lib/mail-sorting/classifier";
const schema = z.object({
	mailboxId: z.string().min(1),
	mode: z.enum(["active", "observe", "off"]),
	dailyLimit: z.number().int().min(0).max(10000),
	threshold: z.number().min(0.8).max(0.99),
});
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId)
		return NextResponse.json({ error: "Mailbox required" }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage)
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	const [settings] = await db
		.select()
		.from(mailboxSortingSettings)
		.where(eq(mailboxSortingSettings.mailboxId, mailboxId))
		.limit(1);
	const [usage] = await db
		.select()
		.from(mailSortingUsage)
		.where(
			and(
				eq(mailSortingUsage.mailboxId, mailboxId),
				eq(mailSortingUsage.day, new Date().toISOString().slice(0, 10)),
			),
		)
		.limit(1);
	const overrides = await db
		.select()
		.from(mailSortingOverrides)
		.where(eq(mailSortingOverrides.mailboxId, mailboxId));
	return NextResponse.json({
		settings: settings ?? { mailboxId, ...DEFAULT_SORTING_SETTINGS },
		usage: usage ?? { requests: 0, inputTokens: 0 },
		available: !!env.AI,
		model: SORTING_MODEL,
		learningExamples: (await getSortingExamples(env, mailboxId)).length,
		overrides,
	});
}
export async function POST(request: Request) {
	if (!hasValidSessionMutationOrigin(request))
		return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canManage)
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	await db
		.insert(mailboxSortingSettings)
		.values(parsed.data)
		.onConflictDoUpdate({
			target: mailboxSortingSettings.mailboxId,
			set: parsed.data,
		});
	return NextResponse.json({ ok: true });
}
export async function DELETE(request: Request) {
	if (!hasValidSessionMutationOrigin(request))
		return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const parsed = z
		.object({ mailboxId: z.string().min(1), sender: z.string().min(1).optional(), clearLearning: z.boolean().optional() })
		.refine((value) => !!value.sender !== !!value.clearLearning)
		.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return NextResponse.json({ error: "Invalid sender" }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canManage)
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	if (parsed.data.clearLearning) {
		await env.DB.prepare("DELETE FROM mail_sorting_feedback WHERE mailbox_id=?").bind(parsed.data.mailboxId).run();
		return NextResponse.json({ ok: true });
	}
	await db
		.delete(mailSortingOverrides)
		.where(
			and(
				eq(mailSortingOverrides.mailboxId, parsed.data.mailboxId),
				eq(mailSortingOverrides.sender, parsed.data.sender!),
			),
		);
	return NextResponse.json({ ok: true });
}
