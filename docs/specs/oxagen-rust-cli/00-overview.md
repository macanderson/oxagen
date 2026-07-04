# Oxagen Rust CLI — Overview & Index

**Status:** proposed spec, not yet started. **Owner:** Mac Anderson. **Linear:** file
one `epic` ticket (`oxagen-v2` project, label `agents`+`tech-debt`) linking this
directory, then sub-issues per phase in `03-plan.md`.

## What this is

A ground-up rebuild of the Oxagen CLI as **`oxagen-cli`**: a single static Rust
binary, MIT/Apache-2.0 open source, with **zero required dependency on
oxagen.sh**. It talks directly to whatever model provider the user configures —
Anthropic, OpenAI, AWS Bedrock (incl. Model Garden), Google Vertex AI (incl.
Model Garden), OpenRouter, Ollama, or any OpenAI-compatible endpoint — using the
user's own keys (BYOK). It bakes in everything that makes today's TypeScript
`@oxagen/cli` good (agent loop, tool set, code-graph context engine, REPL/TUI,
fleet/multi-agent, memory) and removes everything that assumes an Oxagen
account, billing, or platform round-trip. Target: **#1 on SWE-bench Verified
by >3 points** over the next-best agentic coding CLI, at a fixed/pinned model.

This is a **fork-and-diverge**, not a fork-and-sync: `oxagen-cli` (Rust, OSS)
and `@oxagen/cli` (TypeScript, platform-integrated, stays proprietary per the
repo's `LICENSE`) become two separate products from day one of the port,
sharing only ideas and, during migration, a golden-trajectory test corpus. The
proprietary CLI is **not deprecated** — it keeps serving oxagen.sh customers
who want the metered/managed experience, graph sync to the web app, org/
workspace commands, billing, plugins, etc. Those ~120 platform-bound commands
(org, workspace, billing, plugin, document, image/video generation, MCP
registry, automations — see `apps/cli/GAPS.md`) have **no home in the OSS
product** and are deliberately left behind.

## Documents in this set

| Doc | Contents |
|---|---|
| `00-overview.md` | This file. |
| `01-product-spec.md` | Mission, non-negotiables, feature parity matrix (keep/cut/rebuild), provider model, licensing, distribution, success metrics. |
| `02-architecture.md` | Crate layout, port/trait boundaries, data flow, on-disk formats, security model. |
| `03-plan.md` | Phased build plan (0→6), branch/worktree strategy, exit criteria per phase, effort estimates. |
| `04-benchmark-strategy.md` | How we prove and defend the ">3pp #1 on SWE-bench" claim: harness, methodology, anti-p-hacking rules, best-of-N design, continuous leaderboard tracking. |
| `05-risk-register.md` | What can go wrong, mitigations, kill criteria. |

## TL;DR decisions

1. **Language:** Rust, edition 2024, `tokio` async runtime, `clap` for CLI, `ratatui` for TUI.
2. **License:** Apache-2.0 for the engine/tools crates, MIT for the CLI binary crate and public SDK/protocol crate — dual so either downstream license preference is satisfied (matches the Rust ecosystem norm: `tokio`, `ratatui`, `rustls` are all MIT/Apache-2.0 dual).
3. **No Oxagen account required, ever, for core agentic coding.** Login/telemetry/graph-sync/memory-sync to oxagen.sh are **strictly optional, additive, opt-in** plugins — never on the critical path, never required for `oxagen run "fix the failing test"` to work with just `ANTHROPIC_API_KEY` set.
4. **Providers:** first-class native adapters for Anthropic, OpenAI, AWS Bedrock (incl. Bedrock Model Garden / custom imported models), Google Vertex AI (incl. Vertex Model Garden), OpenRouter, Ollama/local OpenAI-compatible servers (LM Studio, vLLM, llama.cpp server). No Vercel AI Gateway dependency in the OSS binary — that was the platform-specific routing layer; direct provider SDKs only.
5. **Reuse strategy:** port the *spec*, not the code (per the existing `04-rust-port.md`). TS engine (`packages/agent-engine`) becomes the executable spec + golden-trajectory oracle during migration, then is retired for this product's purposes (the proprietary CLI keeps using it independently).
6. **Where it lives:** new top-level directory `crates/oxagen-cli/` in this monorepo initially (fastest to build/test against existing bench harness + CI), mirrored out to a public `oxagen-cli` GitHub repo via a one-way export script once Phase 3 lands (see `03-plan.md` §6). It does **not** become a `pnpm` workspace member — it's a Cargo workspace living inside the pnpm/turbo monorepo, same pattern as any polyglot subtree, wired into CI as its own job.
7. **Distribution:** `cargo install oxagen-cli`, Homebrew tap, prebuilt binaries (GitHub Releases, `cargo-dist` or `cross` + GH Actions for macOS/Linux/Windows × x86_64/arm64), and a `curl | sh` installer script. No npm package for the Rust binary (avoids Node dependency entirely — the whole point).
