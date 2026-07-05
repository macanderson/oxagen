---
name: e2e-shard-cancellation-masks-sibling-failures
type: observation
domain: ci
severity: P2
linear: none
date: 2026-07-04
---

**Observation:** The e2e workflow runs 4 sharded Playwright jobs (`e2e (1..4)`). When one shard fails, the run's fail-fast cancels the sibling shards. So a single reproducible failure (here `chat-tool-io-structured.spec.ts` in shard 3) **masks every other latent failure** in the cancelled shards — they show `conclusion: cancelled`, never `failure`, so nobody sees them.

**Consequence seen (PR #627):** fixing the shard-3 tool-io failure let shard 2 run to completion for the first time in many `main` runs, which immediately surfaced TWO pre-existing failures that had been invisible: `chat-attachments.spec.ts` (real Vercel Blob upload with no CI `BLOB_READ_WRITE_TOKEN`) and a separately-red `test` job (multimodal unit tests: extract-video-frames, code-diff-card, terminal-trace-card). All predate the fix.

**Instinct for future fixes:** when you repair the FIRST failing e2e shard, expect newly-green shards to reveal further pre-existing failures. Don't assume your change caused them — check `gh run list --branch main` for each job's recent conclusions (a run of `cancelled`/`failure` on `main` before your branch existed = pre-existing). Confirm your own changed files are green in isolation, keep your PR focused on the assigned fix, and report/ticket the newly-unmasked failures separately rather than folding uncertain infra changes into the fix PR.
