# Cloudflare System One sorting model review — 28 October 2026

## Verified models and API

The live Workers AI catalog and input/output schemas were fetched on this date. All three models were called successfully through the account's native Workers AI API:

| Model | Architecture stated in catalog | Context | USD per million input tokens |
|---|---|---:|---:|
| `@cf/cloudflare/clef-flash` | 9B | 24,576 | 0.038 |
| `@cf/cloudflare/clef` | 27B | 65,536 | 0.24 |
| `@cf/cloudflare/clef-omni` | 30B MoE, 3B active | 65,536 | 0.15 |

Cloudflare describes these as decision models using the System One API: a state plus typed `choice`, `noul` (yes probability) and optional `score` questions. Mailflare already used Flash. Switching to a decision model alone would therefore not fix the earlier application-policy error.

The existing four questions are retained: primary-inbox relevance, category, personal action, genuine security event. The request builder is now shared by production and the reproducible evaluation. A single constant selects both the native route and the required body `model` field, preventing an Omni route with a Flash selector. Results from a different reported model fail safely. AI decisions record the requested model; policy version is now 7.

## Comparison

A preliminary 12-case comparison made 36 calls. Validation then used 24 synthetic German/English cases, including 12 additional cases, repeated twice per model (144 calls). Model order rotated on the second repetition. No real mailbox content, attachments or actual case numbers were submitted.

| Model | Matching destination / 48 evaluations | Important mail moved to advertising/spam | REST median | REST p95 |
|---|---:|---:|---:|---:|
| Clef Flash | 26 | 0 | 489 ms | 793 ms |
| Clef | 34 | 0 | 389 ms | 765 ms |
| Clef Omni | 34 | 0 | 315 ms | 672 ms |

Each row has only **24 distinct examples**, not 48 independent messages. These figures measure each model plus the conservative policy resolver, deliberately before deterministic transaction/legal/marketing shortcuts. Important-mail safety also depends on that policy; it is not an isolated model guarantee. Remaining mismatches predominantly retain mail in primary rather than aggressively moving it. No thresholds were lowered to improve this benchmark. These are laboratory REST timings from the workspace, including transport/service effects, not production binding latency, first-mail opening times or a real-user accuracy estimate. Longer mail, quota pressure, different regions, model updates and actual corrections can change outcomes.

The fixtures and reduced per-call evidence are committed:
- `tests/fixtures/sorting-decisions.json`
- `docs/sorting-model-comparison-2026-10-28.json`

**Decision:** use Clef Omni for unresolved mail. It matched Clef in this evaluation, had lower observed latency and costs less per token than Clef. Keep existing rules and safety gates. Do not introduce a model cascade: it would add quota consumption/latency without sufficient additional evidence here.

## Cost and limits

At an assumed 2,000 input tokens per model call, 1,000 calls cost about USD 0.30 for Omni, USD 0.48 for Clef, or USD 0.076 for Flash, before allowances/other infrastructure charges. Omni's incremental cost versus Flash is USD 0.224 in that scenario. Actual invoice cost was not measured. The 180 synthetic evaluation calls used approximately USD 0.03 of catalog-priced input tokens before allowances. Four questions share one call; deterministic matches use zero calls. Daily limits, atomic reservations and the 8-second timeout remain in effect.

## Validation and release

109 local integration tests passed across smart inbox, historical content audit and R2 import. These include exact route/body model matching, recorded model identity, token/quota accounting, mismatched-model fallback, manual learning, permissions, legal safeguards, spam checks, observation/off modes and import behavior. Targeted ESLint and production build passed. TypeScript retains 15 unrelated existing errors, none in changed files. No production mailbox was reclassified and no notification was sent during evaluation.

Run offline checks:

```sh
node --test tests/smart-inbox.test.mjs tests/mail-content-audit.test.mjs tests/r2-mbox-import.test.mjs
npm run build
```

Run the optional **paid live** synthetic comparison using configured Cloudflare credentials (never put tokens in command arguments):

```sh
SORTING_RUNS=2 SORTING_OUTPUT=/tmp/sorting-model-comparison.json node scripts/benchmark-sorting-models.mjs --live
```

`SORTING_MODELS=clef-flash,clef,clef-omni` selects allowed candidates. The script never reads mailbox data. It is intentionally not part of CI.

Release through the existing Git-to-Cloudflare build. No migrations or new bindings. Verify the active artifact includes the Omni native route and safety policy. Roll back by reverting this commit through the same pipeline; existing JSON decision records remain readable. Historical sorting is not automatically started.

## Authoritative sources

- https://developers.cloudflare.com/workers-ai/models/clef-flash/
- https://developers.cloudflare.com/workers-ai/models/clef/
- https://developers.cloudflare.com/workers-ai/models/clef-omni/
- Authenticated catalog: `GET /accounts/{account}/ai/models/search`
- Authenticated schema: `GET /accounts/{account}/ai/models/schema?model=…`
- Verified inference: `POST /accounts/{account}/ai/run/@cf/cloudflare/{model}`
