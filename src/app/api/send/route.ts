import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { resolveCurrentUser } from "@/lib/auth/cookies";
import { sendEmailSchema } from "@/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { getUndoSeconds, parseSendRequest } from "./utils";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getSendErrorStatus } from "./error-utils";
import { getDb } from "@/db";
import { agentDraftMetadata, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { loadMessageAttachmentContents, MissingAttachmentError } from "@/lib/email/attachments";
import { userOwnsDraft } from "@/app/api/drafts/utils";
import { DeliveryOutcomeError } from "@/lib/email/send-errors";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";

export async function POST(request: Request) {
	const env = getEnv();
	const { user, failure } = await resolveCurrentUser(env, request);
	if (!user) {
		return NextResponse.json(
			{ error: failure === "origin" ? "Invalid origin" : "Unauthorized" },
			{ status: failure === "origin" ? 403 : 401 },
		);
	}
	let input;
	try {
		input = await parseSendRequest(request);
	} catch (error) {
		const tooLarge = error instanceof RequestBodyTooLargeError;
		return NextResponse.json({ error: tooLarge ? "Request body is too large" : "Invalid send request" }, { status: tooLarge ? 413 : 400 });
	}
	const { attachments = [], draftId, undoSeconds, ...fields } = input;
	const parsed = sendEmailSchema.omit({ attachments: true }).safeParse(fields);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	// Files already stored on the draft (a forwarded message's attachments) ride
	// along with whatever the composer uploaded in this request.
	let sourceDraft: { id: string; rawR2Key: string | null } | null = null;
	try {
		if (draftId) {
			const db = getDb(env);
			const [draft] = await db.select().from(messages).where(eq(messages.id, draftId)).limit(1);
			if (!userOwnsDraft(draft, user.id)) {
				return NextResponse.json({ error: "Draft not found" }, { status: 404 });
			}
			const [agent] = await db.select({ draftId: agentDraftMetadata.draftId }).from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, draftId)).limit(1);
			if (agent) return NextResponse.json({ error: "Review and confirm this AI draft before sending" }, { status: 409 });
			attachments.push(...(await loadMessageAttachmentContents(env, draftId)));
			sourceDraft = { id: draftId, rawR2Key: draft.rawR2Key };
		}

		// An undo window is a short scheduled send: the durable job waits, and
		// cancel-schedule takes the message back to Drafts until delivery claims it.
		// The window starts once the message is ready to wait (sendEmail), not while its files are still
		// being stored, and the answer says how much of it is left on this clock, not the browser's.
		const undoWindow = parsed.data.scheduledAt ? null : getUndoSeconds(undoSeconds);
		const result = await sendEmail(env, {
			userId: user.id,
			...parsed.data,
			...(undoWindow ? { undoSeconds: undoWindow } : {}),
			attachments,
			publicOrigin: new URL(request.url).origin,
		});
		// The message is out (or waiting): its draft goes with it, here and not only when the browser
		// asks afterwards. A second request for the same draft then finds none ("Draft not found")
		// instead of sending the message again. A removal that fails is left to the browser's own.
		if (sourceDraft) {
			await deleteMessageWithObjects(env, getDb(env), sourceDraft.id, sourceDraft.rawR2Key).catch((error: unknown) => {
				console.warn("Sent message's draft could not be removed", error instanceof Error ? error.message : error);
			});
		}
		return NextResponse.json(result.undoUntil
			? { ...result, undoUntil: result.undoUntil.toISOString(), undoRemainingMs: Math.max(0, result.undoUntil.getTime() - Date.now()) }
			: result);
	} catch (err) {
		if (err instanceof MissingAttachmentError) return NextResponse.json({ error: err.message, code: "attachment_unavailable", filename: err.filename }, { status: 409 });
		if (err instanceof DeliveryOutcomeError) return NextResponse.json({ error: err.message, code: err.code }, { status: getSendErrorStatus(err.message) });
		const message = err instanceof Error ? err.message : "Send failed";
		return NextResponse.json({ error: message }, { status: getSendErrorStatus(message) });
	}
}
