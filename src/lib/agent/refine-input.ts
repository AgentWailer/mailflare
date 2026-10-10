import { z } from "zod";

export const REFINE_TEXT_LIMIT = 12_000;
export const REFINE_HISTORY_LIMIT = 60_000;
export const refineReplyContextSchema = z.object({
	mailboxId: z.string().trim().min(1).max(200).optional(),
	threadId: z.string().trim().min(1).max(998).optional(),
	inReplyTo: z.string().trim().min(1).max(998).optional(),
	quotedText: z.string().trim().max(REFINE_HISTORY_LIMIT).optional(),
	subject: z.string().max(998).default(""),
	from: z.string().max(2_000).default(""),
	to: z.string().max(8_000).default(""),
	cc: z.string().max(8_000).default(""),
});
export type RefineReplyContext = z.input<typeof refineReplyContextSchema>;
export const refineSchema = z.object({
	mailboxId: z.string().trim().min(1).max(200),
	action: z.enum(["refine", "reply"]).default("refine"),
	text: z.string().trim().max(REFINE_TEXT_LIMIT).default(""),
	mode: z.enum(["polish", "professional", "friendly", "shorter", "longer"]),
	language: z.enum(["keep", "de", "en"]),
	protectedTokens: z.array(z.string().regex(/^\[\[MAILFLARE_IMAGE_[a-f0-9-]+_\d+\]\]$/)).max(100).refine(tokens => new Set(tokens).size === tokens.length).default([]),
	replyContext: refineReplyContextSchema.optional(),
}).superRefine((input, ctx) => {
	if (input.action === "refine" && !input.text) ctx.addIssue({ code: "custom", path: ["text"], message: "Text is required for refinement" });
	if (input.action === "reply" && !input.replyContext?.threadId && !input.replyContext?.inReplyTo && !input.replyContext?.quotedText) ctx.addIssue({ code: "custom", path: ["replyContext"], message: "Conversation history is required" });
});
export type RefineInput = z.infer<typeof refineSchema>;

