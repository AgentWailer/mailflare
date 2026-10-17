import type { AgentProviderPreset, AgentProviderConfig } from "./provider-types";

export const AGENT_SETTINGS_ID = "default";
export const DEFAULT_CLOUDFLARE_MODEL = "@cf/moonshotai/kimi-k2.5";
export const CLOUDFLARE_WRITING_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** Prefer the enabled writing model without changing the assistant's default. */
export function defaultWritingModel(config: Pick<AgentProviderConfig, "provider" | "models" | "model">) {
	return config.provider === "cloudflare" && config.models.includes(CLOUDFLARE_WRITING_MODEL) ? CLOUDFLARE_WRITING_MODEL : config.model;
}
export const PROVIDER_BASE_URLS: Record<Exclude<AgentProviderPreset, "custom">, string> = {
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	groq: "https://api.groq.com/openai/v1",
};
