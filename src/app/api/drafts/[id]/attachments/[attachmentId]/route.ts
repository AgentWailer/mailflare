import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { agentDraftMetadata, messageAttachments, messages } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { deleteMessageAttachment } from "@/lib/email/attachments";
import { commitAgentDraftMutation, DRAFT_CHANGED_ERROR } from "@/lib/agent/draft-mutation";
import { userOwnsDraft } from "../../../utils";

type DraftAttachmentRouteParams = {
	params: Promise<{ id: string; attachmentId: string }>;
};

/** Drop one file from a draft, e.g. an attachment carried over by Forward the user does not want to send. */
export async function DELETE(request: Request, { params }: DraftAttachmentRouteParams) {
	const { id, attachmentId } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const [draft] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);

	if (!userOwnsDraft(draft, user.id)) {
		return NextResponse.json({ error: "Draft not found" }, { status: 404 });
	}

	const [agent] = await db.select({ revision: agentDraftMetadata.revision }).from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, id)).limit(1);
	if (agent) {
		const [file] = await db.select().from(messageAttachments).where(and(eq(messageAttachments.messageId, id), eq(messageAttachments.id, attachmentId))).limit(1);
		if (!file) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
		try { await commitAgentDraftMutation(env, { draftId: id, revision: agent.revision, removeIds: [attachmentId], human: true }); }
		catch (error) {
			if (error instanceof Error && error.message === DRAFT_CHANGED_ERROR) return NextResponse.json({ error: error.message, code: "draft_changed" }, { status: 409 });
			throw error;
		}
		await Promise.allSettled([env.BUCKET.delete(file.r2Key)]);
	} else if (!await deleteMessageAttachment(env, id, attachmentId)) {
		return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
	}
	return NextResponse.json({ ok: true });
}
