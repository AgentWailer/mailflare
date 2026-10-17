# Cloudflare model review — 17 October 2026

Recommendation for short German/English email edits: **Gemma 4 26B A4B IT with thinking disabled** (`@cf/google/gemma-4-26b-a4b-it`, `chat_template_kwargs: { enable_thinking: false }`). Mistral Small 3.1 is a reasonable alternative. This is a recommendation from a small synthetic evaluation, not a universal quality ranking or a production model switch.

## Evidence and limits

The authenticated Workers AI catalog was fetched live through `/accounts/{account}/ai/models/search?task=Text%20Generation`; it returned 37 entries. Pages 2–4 were empty. Some entries are classifiers, adapter bases or require separate access, so catalog presence alone does not prove suitability or account access. Six native candidates were called with the same artificial German/English input; further calls tested thinking settings. Three candidates then received four paired cases each: German business wording, English business wording, a selected German fragment and a short informal message. No real emails were used.

The paired cases checked preservation of names, amounts, dates, invoice IDs, email addresses and URLs. All three candidates retained these anchors (4/4 cases each); the outputs were also reviewed for negation and conditional commitments. This small sample cannot establish a reliability percentage for future emails. GPT-OSS turned a selected clause into a standalone sentence, illustrating why source context and fragment boundaries matter even when facts remain intact. Gemma added a terminal period to that fragment; Mistral retained the fragment form.

Times below are end-to-end REST request measurements from this workspace, one sample per case. They include network/service variation and do not promise production latency. Paired cases differed in length; average values compare identical cases. Native binding performance may differ.

| Model and tested configuration | Paired mean | Paired range | Input / output USD per 1M tokens |
|---|---:|---:|---:|
| Gemma 4, thinking off | 2.21s | 1.14–3.41s | $0.1 / $0.3 |
| Mistral Small 3.1, defaults | 2.43s | 1.25–4.49s | $0.351 / $0.555 |
| GPT-OSS 120B, reasoning low | 5.08s | 2.19–8.96s | $0.35 / $0.75 |

Illustrative cost for 1,000 edits with 1,000 input + 400 output tokens **per edit**, without cache discounts: Gemma $0.22, Mistral $0.573, GPT-OSS $0.65. Actual billing depends on total billed tokens, including reasoning where applicable, and current prices.

On the shared longer DE/EN example: Gemma thinking-off 4.93s; Mistral 5.55s (earlier call 8.20s); GPT-OSS default reasoning 14.36s; GLM 5.3 Flash defaults 25.30s; DeepSeek V4 Flash 17.86s (reasoning-effort none call 16.14s); Kimi K2.6 reasoning-off 7.06s. Gemma with default thinking exhausted the test’s 2,048 output-token budget in 44.69s without final text, and Kimi K2.6 defaults timed out at 65s. Mailflare currently allows 4,096 output tokens and 60s, so these are diagnostic comparisons, not reproductions of every app limit. Model settings can matter more than the name or the “Flash” suffix.

## Configuration scope

The stored model/provider were inspected without reading credentials or changing settings. The stored `moonshotai/kimi-k3` slug is absent from this native catalog. The installed provider also supports catalog slugs through AI Gateway/unified billing, so native catalog absence is not sufficient evidence that its gateway route is invalid. Its gateway availability and price were not verified in this review. Direct OpenAI/Anthropic/Google model pages were unavailable from the workspace; no claim is made about a global ranking or a complete gateway catalog. No provider, selected model, pricing setting or reasoning configuration was changed.

Clef/Clef Flash/Clef Omni are decision/classification models and should remain separate from writing/refinement. Do not choose them as prose editors solely because they are cheap.

## Catalog entries returned

```text
@cf/openai/gpt-oss-120b
@cf/google/gemma-2b-it-lora
@cf/meta/llama-3.2-3b-instruct
@cf/meta/llama-guard-3-8b
@cf/mistral/mistral-7b-instruct-v0.2-lora
@cf/moonshotai/kimi-k2.7-code
@cf/zai-org/glm-5.3
@cf/utter-project/eurollm-9b-it
@cf/deepseek-ai/deepseek-r1-distill-qwen-32b
@cf/meta/llama-3.1-8b-instruct-fp8
@cf/zai-org/glm-5.3-flash
@cf/meta/llama-3.2-1b-instruct
@cf/moonshotai/kimi-k2.6
@cf/cloudflare/clef
@cf/zai-org/glm-4.7-flash
@cf/meta-llama/llama-2-7b-chat-hf-lora
@cf/meta/llama-3.3-70b-instruct-fp8-fast
@cf/ibm-granite/granite-4.0-h-micro
@cf/deepseek-ai/deepseek-v4-flash-0731
@cf/swiss-ai/apertus-v1.5-8b
@cf/cloudflare/clef-omni
@cf/qwen/qwen2.5-coder-32b-instruct
@cf/zai-org/glm-5.2
@cf/nvidia/nemotron-3-120b-a12b
@cf/aisingapore/gemma-sea-lion-v4-27b-it
@cf/qwen/qwen3-30b-a3b-fp8
@cf/google/gemma-7b-it-lora
@cf/google/gemma-4-26b-a4b-it
@cf/mistralai/mistral-small-3.1-24b-instruct
@cf/deepseek-ai/deepseek-v4-pro-0813
@cf/meta/llama-3.2-11b-vision-instruct
@cf/daily-co/phonellm-mini-alpha-2
@cf/qwen/qwen3.8-27b
@cf/openai/gpt-oss-20b
@cf/meta/llama-4-scout-17b-16e-instruct
@cf/cloudflare/clef-flash
@cf/qwen/qwq-32b
```

## Sources

- [Cloudflare Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/) — catalog and prices were obtained through its authenticated API, not the blocked documentation page.
- [Official Cloudflare API model-list definitions](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/ai/models/models.ts) — query parameters and endpoint.
- Model input schemas were read from `/accounts/{account}/ai/models/schema?model=…`, including Gemma’s `enable_thinking` and Kimi’s `reasoning_effort`.
- Live synthetic probe results are summarized above; they do not certify future language quality.
