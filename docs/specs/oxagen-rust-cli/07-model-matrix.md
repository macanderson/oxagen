# Oxagen Rust CLI — Model Matrix, Roles & Routing

This document specifies the provider adapters, the role-based model router,
the GLM 5.2 default suite, and the catalog rules that keep model references
honest. It exists because the TS era proved model plumbing is where silent
failures breed: phantom slugs, gateway drift, dead resolvers, judge/worker
conflation (`09-lessons-learned.md` L-M*).

## 1. Roles, not "the model"

Every model reference in the engine is a **role**, resolved through one
router. No call site names a model.

| Role | Used by | Default bias |
|---|---|---|
| `worker` | main coding/execution steps | strongest available coding model |
| `triage` | prompt classification, simple-prompt fast path, routing decisions | cheapest/fastest tier — runs on every prompt, must be near-free |
| `plan` | planner (defaults to `worker`; separately overridable) | worker-class |
| `judge` | evidence-based verification, best-of-N selection | **never the same instance as worker**; prefer a *different family* when ≥2 families configured (self-preference bias reduction — SWE-bench cross-family lesson) |
| `embed` | context plane | local ONNX by default (`06-context-protocol.md` §4) |
| `vision` | image-input understanding (screenshots, design refs) | family's multimodal tier |
| `image` | `oxagen-media` image generation | per §5 |
| `video` | `oxagen-media` video generation | per §5 |

User surface: `oxagen config model set <role> <provider>/<model>`, plus REPL
slash equivalents (`/worker-model`, `/triage-model`, `/judge-model`, …) —
carrying over the TS per-function-model UX (PR #659). `--model X` pins the
worker for one invocation; other roles follow the routing table.

**Auto mode is the absence of a pin, not a magic slug.** Internally the
selection is `Option<ModelRef>`; `None` means the router chooses by task
class. The TS bug family where a pseudo-slug (`"auto"`) leaked into resolver
paths and produced dead lookups is structurally excluded — there is no
string in the type (`09-lessons-learned.md` L-M3).

## 2. Provider adapters

| Adapter | Key | Wire | Chat | Embed | Image | Video | Notes |
|---|---|---|---|---|---|---|---|
| Z.ai | `ZAI_API_KEY` | OpenAI-compatible chat + native media endpoints | GLM 5.2 suite | ✓ (embedding API) | CogView family | CogVideoX family | Default suite. Config selects `api.z.ai` (intl) vs `open.bigmodel.cn` base. |
| Anthropic | `ANTHROPIC_API_KEY` | Messages API | Claude Fable 5, Opus, Sonnet, Haiku | – | – | – | Extended thinking mapped to reasoning-effort. |
| OpenAI | `OPENAI_API_KEY` | Responses API | GPT-5.5 family | ✓ | gpt-image | Sora (account-gated) | |
| Gemini direct | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`) | `generativelanguage.googleapis.com` | Gemini 3 family | ✓ | Imagen | Veo | No GCP project needed. |
| xAI | `XAI_API_KEY` | OpenAI-compatible | Grok 4 family | – | grok image | – | |
| Bedrock | AWS chain | Converse/ConverseStream | catalog-driven | ✓ | ✓ (Titan/Nova image where enabled) | – | Model Garden by ARN. |
| Vertex | ADC | generateContent | catalog-driven | ✓ | Imagen | Veo | Enterprise path; casual Gemini use → direct adapter. |
| OpenRouter | `OPENROUTER_API_KEY` | OpenAI-compatible | catalog-driven | – | – | – | On-ramp. |
| Local/OpenAI-compat | `--base-url` | OpenAI-compatible | anything | ✓ (if served) | – | – | Ollama, vLLM, LM Studio, llama.cpp server. |
| On-device GGUF | none | llama.cpp FFI | local models | – | – | – | Feature-flagged per target (risk R3/R8). |

Family names above are **as-of-writing anchors, not slugs**. Exact model ids
come from the catalog (§3). When a provider ships a newer generation, the
catalog refresh picks it up; the spec does not.

Adapter internals each own: SSE/stream parsing, tool-call dialect translation
(§4), reasoning-effort mapping, retryable-vs-terminal error classification,
and a per-provider **circuit breaker** (open after N consecutive transport
failures → router falls back to the next configured provider of that role's
tier, with a loud event — carried from the TS breaker seams work).

## 3. The catalog (no hard-coded slugs, ever)

`oxagen models refresh` pulls each configured provider's `/models` (or
equivalent) endpoint into `~/.config/oxagen/catalog/<provider>.toml`. A
curated, versioned seed catalog ships in the binary so first-run works
offline-ish, but the seed is data, not code.

Catalog entry shape:

```toml
[[model]]
id = "glm-5.2"                 # provider-native slug, verified against /models
family = "glm"
generation = "5.2"
roles = ["worker", "plan", "judge"]
context_window = 200000
max_output = 16384
tool_dialect = "openai-json"    # §4
reasoning_param = "thinking"    # provider-specific mapping key
vision = true
pricing = { input_per_mtok = 0.0, output_per_mtok = 0.0, source = "refresh-2026-07-10" }
```

Binding rules (each one is a TS post-mortem):

1. **A slug not present in the catalog is a hard, immediate, named error**
   ("unknown model `glm-5.2-turbo` — run `oxagen models refresh` or pick
   from `oxagen models list`"), never a silent fallback to a default model.
   (TS shipped a phantom `glm-5.2-turbo` slug; and the gateway's slug drift
   bit repeatedly — L-M1, L-M2.)
2. **Pricing is data with a provenance date.** The budget meter (§6) refuses
   to run in `enforced` mode with stale-beyond-threshold pricing; it warns
   and runs in `observed` mode instead.
3. **Catalog refresh is a user action or an explicit flag** — never an
   ambient network call on startup (non-negotiable #1).

## 4. Tool-call dialects & the GLM 5.2 specialization

The engine speaks one internal tool schema (`oxagen-protocol`); adapters
translate. Dialects: `anthropic-tools`, `openai-json` (OpenAI, Z.ai, xAI,
OpenRouter, local), `gemini-functions`, plus quirk flags per catalog entry
(parallel-call support, strict-JSON mode, streaming-tool-args, max tools).

"Specialized for GLM 5.2" concretely means, at minimum:

1. **Prompt profiles per family.** The system prompt, tool descriptions, and
   few-shot scaffolding are templated per family; the GLM profile is the
   most-tuned and is the one the benchmark loop optimizes
   (`04-benchmark-strategy.md`). Other families get correct-but-less-tuned
   profiles; profile files are data (`profiles/glm.toml`, …), hot-swappable
   without recompile.
2. **Dialect conformance tests against recorded GLM 5.2 transcripts** —
   malformed-call repair tuned to the failure shapes GLM actually produces
   (the TS malformed-call repair was tuned on Claude's; they differ).
3. **Compaction budgets tuned to GLM's context window + tokenizer**, with
   the token estimator validated against Z.ai's usage-reporting fields, not
   assumed from tiktoken.
4. **Default role table** (§5) that gives a complete agent from
   `ZAI_API_KEY` alone.
5. **The specialization is additive, never exclusive** — no GLM-only code
   path may be load-bearing for other families (CI runs the dialect suite
   across all families with recorded fixtures).

## 5. Default role assignments by key scenario

Resolution: explicit pin > per-role config > scenario defaults below.

| Keys present | worker | triage | judge | embed | image | video |
|---|---|---|---|---|---|---|
| `ZAI_API_KEY` only (canonical default) | GLM 5.2 flagship | GLM 5.2 fast tier | GLM 5.2 flagship (distinct instance, judge profile) | local ONNX | CogView | CogVideoX |
| `ANTHROPIC_API_KEY` only | Fable 5 (or best catalog Claude) | Haiku tier | Claude distinct-instance | local ONNX | — (error names which keys enable image) | — |
| `OPENAI_API_KEY` only | GPT-5.5 coding tier | mini tier | GPT-5.5 distinct-instance | local ONNX | gpt-image | Sora if entitled |
| `GEMINI_API_KEY` only | Gemini 3 pro tier | flash tier | Gemini distinct-instance | local ONNX | Imagen | Veo |
| `XAI_API_KEY` only | Grok 4 | Grok fast tier | Grok distinct-instance | local ONNX | grok image | — |
| Z.ai + any frontier key | GLM 5.2 flagship | GLM 5.2 fast tier | **cross-family frontier (e.g. Fable 5 / GPT-5.5 / Gemini 3)** | local ONNX | CogView (or per-role config) | CogVideoX |
| none (local endpoint configured) | local model | local model | local model (flagged: judge quality unverified) | local ONNX | — | — |

The cross-family judge default when multiple families are present is the
single most valuable multi-key behavior (bias-resistant verification;
best-of-N selection quality) and is called out in onboarding.

## 6. Budget & rate accounting

Ported from the TS per-turn budget (PR #625), now with media:

- Three modes: `off`, `observed` (meter + warn), `enforced` (hard stop with
  a clean turn abort — never a mid-tool kill).
- Scope: per-turn USD, per-session USD, or both; configured in
  `config.toml`, overridable per-invocation (`--budget 2.50`).
- **Media counts.** Image/video jobs meter through the same ledger; video
  additionally requires a pre-dispatch confirmation above a configurable
  threshold because single jobs can cost dollars (`08-multimodal.md` §6).
- Usage parsing is adapter-owned and normalized into one envelope
  (`input_tokens`, `output_tokens`, `cached_input_tokens`, `cost_usd`) —
  the TS AI-SDK-v7 usage-shape breakage is why normalization lives in the
  adapter, tested per provider (L-M5).
- `BudgetTick` events stream continuously; the TUI HUD renders spend live.

## 7. Reliability rules

- Retry: jittered exponential on 429/5xx/transport; terminal on 4xx; resume
  from last completed step. Deterministic fast paths (triage classification,
  catalog lookups) run with `max_retries = 0` and fall through gracefully —
  a fast path that can hang is not a fast path (L-M4).
- Timeouts: per-step ceilings by role; **never blanket-raise a turn timeout
  to accommodate one slow tool** — long externals (CI watch) are deferred
  waits outside the model step, capped independently (L-E4).
- Fallback: circuit breaker per adapter (§2); router announces fallback via
  a loud event; no silent family switches mid-turn.
