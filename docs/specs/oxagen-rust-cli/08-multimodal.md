# Oxagen Rust CLI — Multimodal Generation

Text, code, images, SVG, and video from one binary, all client-side, all
BYOK, through the same provider layer and budget meter as chat
(`07-model-matrix.md`). Rev 1 cut media because the TS implementation was an
oxagen.sh server round-trip; this rebuilds the user value with zero platform
dependency.

## 1. Surfaces (every generator is both a command and an agent tool)

```
oxagen gen image "a wordmark, ember orange on charcoal" [--size 1024x1024] [--n 2] [--out path]
oxagen gen svg "architecture diagram of <description>" [--out path] [--preview]
oxagen gen video "10s product teaser: …" [--duration 10] [--out path]   # cost-gated
oxagen gen text "…" / oxagen gen code "…"    # thin aliases over one-shot run with role presets
```

REPL: `/image`, `/svg`, `/video` slash commands. Agent tools:
`generate_image`, `generate_svg`, `generate_video` in the default toolset —
the agent can produce a diagram for the README or a fixture image for a test
mid-task. Tool outputs are artifact references, never base64 blobs in the
transcript (context hygiene).

## 2. Provider capability map (via the `MediaProvider` trait)

| Capability | Z.ai (default) | OpenAI | Gemini | xAI | Bedrock |
|---|---|---|---|---|---|
| Image gen | CogView family | gpt-image | Imagen | grok image | Titan/Nova image |
| Image edit/variation | per catalog | ✓ | ✓ | – | – |
| Video gen | CogVideoX family | Sora (entitlement-gated) | Veo | – | – |

Same catalog rules as chat models: capabilities and slugs are catalog data
refreshed from providers, never hard-coded; a request for a capability no
configured key can serve fails loudly, naming which keys would enable it.

SVG has **no dedicated provider** — it is a *worker-model structured-output
pipeline* (§4), which is why it works with any chat key.

## 3. Image pipeline

1. Prompt (+ optional input images for edit/variation where supported).
2. Dispatch to the `image` role's provider; `--n` for candidates.
3. Artifacts land in `<ws>/.oxagen/artifacts/<yyyymmdd>/<slug>-<n>.png` +
   manifest row (prompt, model, params, cost, sha256).
4. Terminal preview (§5); `Complete` event carries the artifact ref.

## 4. SVG pipeline (generate → validate → repair → optimize → preview)

LLM-generated SVG is code generation and is treated with code discipline —
mechanical validation, never trust (the TS agent-definition work proved
LLM-output post-validation must be deterministic, L-V2):

1. `worker` role generates SVG via structured output (single `svg` field —
   no prose contamination).
2. **Validate:** parse with `usvg`. Parse failure → repair loop: error
   message + offending source back to the model, max 2 repair rounds, then
   fail with the last error (never emit an artifact that didn't parse).
3. **Sanitize:** strip scripts/event handlers/external refs (SVG is an
   active format; artifacts must be inert), enforce a viewBox, deterministic
   id-prefixing so artifacts can be inlined safely.
4. **Optimize:** usvg's simplification pass (path flattening optional).
5. **Preview:** rasterize via `resvg` for terminal preview; write both
   `.svg` and preview `.png` to artifacts.

`oxagen graph viz` (`06-context-protocol.md` §2.4) reuses this pipeline's
tail (sanitize→optimize→preview) over deterministically-generated (not
LLM-generated) SVG from graph layouts.

## 5. Terminal preview

Protocol ladder, feature-detected once per session: kitty graphics protocol →
iTerm2 inline images → sixel → chafa-style unicode-block mosaic → file-path
line only. Never assume; never emit raw escape sequences to a terminal that
did not advertise them (the TS TUI's terminal-capability lessons, L-T*, apply:
degrade politely, keep the raw bytes out of the scrollback). `--no-preview`
for CI; previews are always additive to the on-disk artifact, never a
substitute.

## 6. Cost gates

- All media meters through the per-turn/session budget (`07-model-matrix.md`
  §6).
- **Video is confirmation-gated by default:** above a configurable USD
  threshold (default: any video), the CLI prints the estimated cost from the
  catalog rate card and requires confirmation (`--yes` for headless).
- Async video jobs poll with capped, jittered backoff and survive Ctrl-C:
  job ids persist in the artifact manifest, `oxagen gen video --resume <id>`
  reattaches — a dollar-cost job must never be orphaned by a dropped
  terminal (application of the sandbox-lifecycle truthfulness lesson: the
  manifest reconciles against the provider before claiming a job's state,
  L-V3).
- The agent tools inherit the same gates: an agent cannot dispatch video
  without the gate passing (interactive: user confirms; headless: only if
  `--yes`/budget headroom).

## 7. Testing

- Recorded-fixture tests per provider adapter (request/response transcripts,
  including failure shapes: content-policy refusals, entitlement 403s, slow
  jobs) — CI never calls paid APIs.
- One live smoke per release per provider family with keys present, skipped
  otherwise, producing a checked artifact into `verifications/`.
- SVG pipeline: property tests (sanitizer idempotence; validator rejects the
  OWASP SVG attack corpus; repair loop terminates), golden renders compared
  by perceptual hash, not bytes.

## 8. Future (explicitly not v1)

Audio (TTS/STT/music) and 3D fit the `MediaProvider` trait shape; the trait
reserves method-space (`generate_audio` behind a feature flag, unimplemented)
but no v1 work is scoped. Image *understanding* (screenshots as input) is the
`vision` chat role, not `oxagen-media`, and ships with the core loop.
