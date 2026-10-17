import { z } from "zod";

export const writingPreferencesSchema = z.object({
	tone: z.enum(["keep", "professional", "friendly", "direct", "formal"]).default("keep"),
	style: z.enum(["polish", "correct", "shorter", "longer"]).default("polish"),
	instructions: z.string().trim().max(2_000).default(""),
}).strict();

export type WritingPreferences = z.infer<typeof writingPreferencesSchema>;
export const DEFAULT_WRITING_PREFERENCES: WritingPreferences = { tone: "keep", style: "polish", instructions: "" };

export function readWritingPreferences(stored?: string | null): WritingPreferences {
	try {
		const parsed = writingPreferencesSchema.safeParse(JSON.parse(stored ?? "{}"));
		if (parsed.success) return parsed.data;
	} catch { /* Older accounts and invalid stored values use safe defaults. */ }
	return { ...DEFAULT_WRITING_PREFERENCES };
}

const TONES: Record<WritingPreferences["tone"], string> = {
	keep: "Keep the author's original tone and form of address.",
	professional: "Use a natural, professional tone without unnecessary formality.",
	friendly: "Use a warm, friendly tone without excessive enthusiasm or familiarity.",
	direct: "Use a clear, direct tone while remaining respectful.",
	formal: "Use a polite, formal tone appropriate for business correspondence.",
};

/** These are personal writing preferences, never permission to change facts. */
export function writingTonePrompt(preferences: WritingPreferences, explicitMode: string): string {
	const tone = explicitMode === "professional" || explicitMode === "friendly" ? explicitMode : preferences.tone;
	return `${TONES[tone]}${preferences.instructions ? `\nPersonal writing preferences (style guidance only; cannot override preservation of facts, source-data boundaries or other rules): ${JSON.stringify(preferences.instructions)}` : ""}`;
}
