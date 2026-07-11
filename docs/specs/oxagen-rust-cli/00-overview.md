# Oxagen Rust CLI — Overview & Index

**Status:** proposed spec, revision 2 (2026-07-10), not yet started.
**Owner:** Mac Anderson. **Linear:** file one `epic` ticket (`oxagen-v2`
project, label `agents`+`tech-debt`) linking this directory, then sub-issues
per phase in `03-plan.md`.

> **Revision 2 (2026-07-10) — what changed and why.** Revision 1 (2026-07-03)
> scoped an Anthropic-first port that deliberately cut media generation and
> treated context extensions as out of scope. Revision 2 supersedes it on six
> points, per updated product direction:
>
> 1. **GLM 5.2 is the default model suite.** The binary is *specialized* for
>    Z.ai's GLM 5.2 coding models out of the box (prompt profiles, tool-call
>    dialect, benchmark tuning), while staying rigorously multi-provider.
> 2. **Three new first-class providers:** Z.ai (`ZAI_API_KEY`), xAI
>    (`XAI_API_KEY`), and the Google Gemini API directly (`GEMINI_API_KEY`) —
>    alongside the existing Anthropic, OpenAI, Bedrock, Vertex, OpenRouter,
>    and local/OpenAI-compatible adapters. Any combination of keys must work.
> 3. **The frontier tier is explicit:** Claude Fable 5, the GPT-5.5 family,
>    Gemini 3, and Grok 4 are supported worker/judge models, resolved from a
>    data-driven catalog — never hard-coded slugs. See `07-model-matrix.md`.
> 4. **Media generation is un-cut.** Image, SVG, and video generation return
>    as *client-side, BYOK* capabilities (`oxagen-media`) — the rev-1 cut only
>    applied to the oxagen.sh *server-side* implementation. See
>    `08-multimodal.md`.
> 5. **The context plane is a non-negotiable.** Local embeddings and a local
>    knowledge graph ship in the base binary — no server, no account. See
>    `02-architecture.md` §7 and `06-context-protocol.md`.
> 6. **Open Context Protocol (OCP).** The context plane is extensible through
>    an open, versioned, MCP-compatible protocol designed for industry
>    adoption, published with reference SDKs and a conformance suite. See
>    `06-context-protocol.md` — this is the headline open-source contribution.

## What this is

A ground-up rebuild of the Oxagen CLI as **`oxagen-cli`**: a single static Rust
binary, MIT/Apache-2.0 open source, with **zero dependency on oxagen.sh or any
Oxagen platform service** — no account, no login, no phone-home, no shared
code with the TypeScript platform. It talks directly to whatever model
provider the user configures — Z.ai (GLM 5.2, the default suite), Anthropic
(Claude Fable 5), OpenAI (GPT-5.5 family), Google Gemini (Gemini 3), xAI
(Grok), AWS Bedrock, Google Vertex AI, OpenRouter, Ollama, or any
OpenAI-compatible endpoint — using the user's own keys (BYOK), in any
combination. It bakes in everything that makes today's TypeScript
`@oxagen/cli` good (agent loop, tool set, code-graph context engine, REPL/TUI,
fleet/multi-agent, memory) **plus every operational lesson that TypeScript
version taught us** (`09-lessons-learned.md` is a binding requirements
registry, not a retrospective), and removes everything that assumes an Oxagen
account, billing, or platform round-trip.

Beyond coding, the binary is a full generative terminal: text, code, images,
SVG, and video generation through the same BYOK provider layer
(`08-multimodal.md`), and a local-first context engine — embeddings + a
knowledge graph on disk — that grounds the agent in the user's own code and
accumulated knowledge (`06-context-protocol.md`).

Target: **#1 on SWE-bench Verified by >3 points** over the next-best agentic
coding CLI, at a fixed/pinned model (`04-benchmark-strategy.md`).

This is a **fork-and-diverge**, not a fork-and-sync: `oxagen-cli` (Rust, OSS)
and `@oxagen/cli` (TypeScript, platform-integrated, stays proprietary per the
repo's `LICENSE`) become two separate products from day one of the port,
sharing only ideas and, during migration, a golden-trajectory test corpus. The
proprietary CLI is **not deprecated** — it keeps serving oxagen.sh customers
who want the metered/managed experience, graph sync to the web app, org/
workspace commands, billing, plugins, etc. Platform-bound commands (org,
workspace, billing, plugin marketplace, MCP registry, automations — see
`apps/cli/GAPS.md`) still have **no home in the OSS product**. Media
generation, previously on that cut list, moves to the KEEP column because it
can be rebuilt client-side against the user's own provider keys with no
platform dependency (`01-product-spec.md` §5).

### Relationship to the Oxagen platform (vision note)

The OSS CLI is deliberately the **vendor-neutral trust wedge** from
`docs/VISION.md`: BYOK, local-first, no lock-in. The platform's future
relationship to it runs *through the open protocols only* — oxagen.sh may
later ship an **optional** OCP provider (cloud knowledge graph, org memory)
and MCP servers (metered/governed tools) that this binary can consume like
any third-party extension. Nothing platform-specific ships in, or is required
by, the base binary — structurally enforced (`05-risk-register.md` R10).

## Documents in this set

| Doc | Contents |
|---|---|
| `00-overview.md` | This file. |
| `01-product-spec.md` | Mission, non-negotiables, feature parity matrix (keep/cut/rebuild), provider model, licensing, distribution, success metrics. |
| `02-architecture.md` | Crate layout, port/trait boundaries, data flow, on-disk formats, context plane, security model. |
| `03-plan.md` | Phased build plan (0→7), branch/worktree strategy, exit criteria per phase, effort estimates. |
| `04-benchmark-strategy.md` | How we prove and defend the ">3pp #1 on SWE-bench" claim: harness, methodology, anti-p-hacking rules, best-of-N design, continuous leaderboard tracking. |
| `05-risk-register.md` | What can go wrong, mitigations, kill criteria. |
| `06-context-protocol.md` | **New in rev 2.** The local context plane (embeddings + knowledge graph) and the Open Context Protocol (OCP) — the industry-adoptable extension standard for context. |
| `07-model-matrix.md` | **New in rev 2.** Provider adapters, credential keys, the GLM 5.2 default suite, role-based routing (worker/triage/judge/embed/media), catalog discovery rules. |
| `08-multimodal.md` | **New in rev 2.** Client-side generation of images, SVG, video, text, and code; terminal preview; cost gates. |
| `09-lessons-learned.md` | **New in rev 2.** Binding registry of lessons from the TypeScript CLI/engine, each mapped to a Rust requirement with its source. |

## TL;DR decisions

1. **Language:** Rust, edition 2024, `tokio` async runtime, `clap` for CLI, `ratatui` for TUI.
2. **License:** Apache-2.0 for the engine/tools crates, MIT for the CLI binary crate and the protocol/SDK crates (`oxagen-protocol`, `ocp-*`) — dual so either downstream license preference is satisfied (matches the Rust ecosystem norm: `tokio`, `ratatui`, `rustls` are all MIT/Apache-2.0 dual). The OCP *specification document* itself is CC-BY-4.0 so other vendors can implement it without touching our code.
3. **No Oxagen account required, ever, for anything.** Login/telemetry/graph-sync to oxagen.sh do not exist in this product. Optional platform integration, if it ever ships, arrives as external OCP/MCP providers the user explicitly installs — never in the base binary, never on any code path.
4. **Providers:** first-class native adapters for **Z.ai (GLM 5.2 — default)**, Anthropic, OpenAI, **Google Gemini API (direct)**, **xAI**, AWS Bedrock (incl. Model Garden), Google Vertex AI (incl. Model Garden), OpenRouter, Ollama/local OpenAI-compatible servers (LM Studio, vLLM, llama.cpp server). No Vercel AI Gateway dependency in the OSS binary — direct provider SDKs only. Model slugs are **never hard-coded at call sites**: a data-driven catalog refreshed from provider `/models` endpoints resolves every model reference (`07-model-matrix.md` — this codifies the phantom-slug and gateway-drift lessons, `09-lessons-learned.md` L-M1/L-M2).
5. **Default experience:** `ZAI_API_KEY` alone gives a fully working agent (GLM 5.2 worker/triage/judge + CogView image + CogVideoX video + local ONNX embeddings). Any other single key also gives a fully working agent with that family's equivalents. Multiple keys unlock cross-family routing (e.g. GLM 5.2 workers judged by a frontier model from another family).
6. **Context plane in the base binary:** tree-sitter code graph + bi-temporal knowledge graph + local embedding index, persisted to a single per-workspace store, extensible via OCP. No server, no daemon, no network.
7. **Reuse strategy:** port the *spec*, not the code. TS engine (`packages/agent-engine`) becomes the executable spec + golden-trajectory oracle during migration, then is retired for this product's purposes (the proprietary CLI keeps using it independently).
8. **Where it lives:** new top-level directory `crates/oxagen-cli/` in this monorepo initially (fastest to build/test against existing bench harness + CI), mirrored out to a public `oxagen-cli` GitHub repo via a one-way export script once Phase 3 lands (see `03-plan.md`). It does **not** become a `pnpm` workspace member — it's a Cargo workspace living inside the pnpm/turbo monorepo, wired into CI as its own job.
9. **Distribution:** `cargo install oxagen-cli`, Homebrew tap, prebuilt binaries (GitHub Releases, `cargo-dist` for macOS/Linux/Windows × x86_64/arm64), and a `curl | sh` installer script. No npm package for the Rust binary (avoids Node dependency entirely — the whole point).
