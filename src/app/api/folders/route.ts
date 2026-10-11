import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { folderSchema } from "@/lib/validators";
import { getFolderForMailbox, getMailboxFolderAccess, listFoldersForMailbox } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ folders: [] });
	}

	const db = getDb(env);
	const access = await getMailboxFolderAccess(db, user, mailboxId);
	if (!access) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const rows = await listFoldersForMailbox(db, mailboxId);
	return NextResponse.json({ folders: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const parsed = folderSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxFolderAccess(db, user, parsed.data.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	if (parsed.data.parentId && !(await getFolderForMailbox(db, parsed.data.parentId, parsed.data.mailboxId))) {
		return NextResponse.json({ error: "Parent label not found" }, { status: 404 });
	}
	const name = parsed.data.name.trim();
	const [existing] = await db
		.select()
		.from(folders)
		.where(and(eq(folders.mailboxId, parsed.data.mailboxId), eq(folders.name, name)))
		.limit(1);
	if (existing) {
		return NextResponse.json({ error: "Folder already exists" }, { status: 409 });
	}

	const id = newId("fld");
	try {
		await db.insert(folders).values({
			id,
			userId: access.mailboxUserId,
			mailboxId: parsed.data.mailboxId,
			name,
			parentId: parsed.data.parentId ?? null,
			color: parsed.data.color,
		});
	} catch (error) {
		const detail = String(error) + String((error as { cause?: unknown }).cause ?? "");
		if (detail.includes("Invalid label parent") || detail.includes("UNIQUE constraint") || detail.includes("FOREIGN KEY constraint")) {
			return NextResponse.json({ error: "Label or parent changed. Please try again." }, { status: 409 });
		}
		throw error;
	}

	return NextResponse.json({ id, mailboxId: parsed.data.mailboxId, name, parentId: parsed.data.parentId ?? null, color: parsed.data.color });
}
