import { z } from "zod";

export const REFINE_TEXT_LIMIT = 12_000;
export const refineSchema = z.object({
	mailboxId: z.string().trim().min(1).max(200),
	text: z.string().trim().min(1).max(REFINE_TEXT_LIMIT),
	mode: z.enum(["polish", "professional", "friendly", "shorter", "longer"]),
	language: z.enum(["keep", "de", "en"]),
	protectedTokens: z.array(z.string().regex(/^\[\[MAILFLARE_IMAGE_[a-f0-9-]+_\d+\]\]$/)).max(100).refine(tokens => new Set(tokens).size === tokens.length).default([]),
});
export type RefineInput = z.infer<typeof refineSchema>;

