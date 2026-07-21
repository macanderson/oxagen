# Oxagen Competitive Ratings Report

**Date:** 2026-07-10 · **Branch:** `claude/codebase-audit-optimization-eg6keu` · **Basis:** internal code audit (this repo) vs. a 15-platform competitor dossier compiled from public sources (July 2026).

Scoring is 1–100 per cell = *maturity/completeness of the capability as it exists today.* Competitor numbers are lifted from the research dossier (`scratchpad/findings/competitors.md`, sourced inline there). Oxagen numbers are derived from the internal audit evidence (agent-engine, routes-inventory, schema, silent-errors, over-engineering, docs, tests, dead-code) plus direct reads of `packages/billing`, `packages/ontology`, `packages/oxagen` contracts, and `docs/VISION.md`. **Oxagen is scored from code, not from production usage — it is pre-launch, so every "proof/scale" axis is discounted accordingly.**

---

## 1. Executive summary

Oxagen is a **pre-launch platform with a genuinely differentiated core and almost no external gravity.** The engineering is real and, in its wedge areas, ahead of what any single incumbent bundles: a metered, IAM-governed capability kernel (`invoke()` binds identity → entitlement → metering → audit for all 308 first-party capabilities), an ontology-governed Neo4j graph with 4-engine grounded retrieval and cited answers, and an end-to-end ClickHouse→credits→Stripe billing loop with a solved-margin markup. Against the *agent-platform* field (OpenAI, Anthropic, Google, MSFT, AWS, LangChain, CrewAI, Braintrust) these three areas are its moat; against the *billing-rail* specialists (Stripe/Metronome, Orb, Paid.ai) the billing loop is real but single-tenant and unproven.

**Three defensible strengths:**
1. **Vendor-neutral BYOK by construction** (78) — `modelIdOf()` + AI Gateway + tier→slug env swap, no hard-coded model slugs (lint-enforced); a real trust moat, near the LangChain/Bedrock class.
2. **Ontology-governed, cited graph grounding** (74) — `packages/ontology` + engram's temporal/vector/graph/lexical fusion + `NodeRef` citations + a 23-capability schema registry; the developer-first, BYOK graph the dossier says nobody owns.
3. **The governed-metering-to-billing bundle** — governed contracts (70) + metering (72) + billing loop (60) wired through one kernel; no competitor binds runtime governance to customer billing in one object.

**Three biggest gaps:**
1. **Ecosystem / mindshare (8)** — no users, community, stars, or partner network; the marketing site is an investor deck.
2. **Marketplace / distribution (30)** — real install UI and plugin packs, but zero reach or third-party network.
3. **Evals (40)** and **reseller/agency multi-tenancy (42)** — eval UI is a read-only nav orphan; tenancy is team-scoped (org/workspace), not the agency-bills-its-customers model the "resell" mission requires.

Net: the wedge is real in code but the un-poisonable-external-MCP claim, the agency-billing layer, and the entire go-to-market remain unbuilt.

---

## 2. The scoring matrix

Columns: **Oxg** = Oxagen (this audit). Others from the dossier. **Niche leaders** cites the strongest specialist per row (Glean = graph; Sierra = outcome pricing; Stripe+Metronome = billing rail; Braintrust = evals) as the true ceiling.

| # | Dimension | Oxg | OpenAI | Anthr | Googl | MSFT | AWS | LangC | CrewAI | Braintr | Niche leaders (notes) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Agent orchestration / runtime | **68** | 75 | 82 | 88 | 85 | 88 | 90 | 76 | 15 | LangGraph 90; Sierra 82 |
| 2 | Tool / MCP ecosystem | **48** | 85 | 95 | 82 | 82 | 82 | 85 | 70 | 40 | Anthropic 95; Glean gateway 80 |
| 3 | Typed / governed tool contracts & policy | **70** | 62 | 70 | 70 | 80 | 76 | 48 | 45 | 20 | MSFT Entra 80; nobody binds commercial terms |
| 4 | Knowledge grounding / graph RAG | **74** | 52 | 50 | 72 | 68 | 80 | 58 | 45 | 10 | **Glean 90**; Writer 85; AWS 80 |
| 5 | Memory | **72** | 50 | 55 | 80 | 76 | 85 | 72 | 60 | 8 | AWS 85; Sierra ADP 78 |
| 6 | Evals & testing | **40** | 40 | 42 | 70 | 72 | 70 | 85 | 48 | 95 | **Braintrust 95**; LangSmith 85 |
| 7 | Observability / tracing | **62** | 60 | 50 | 72 | 76 | 80 | 92 | 58 | 88 | **LangSmith 92**; Braintrust 88 |
| 8 | Usage metering & cost tracking | **72** | 65 | 68 | 62 | 66 | 70 | 60 | 45 | 55 | **Stripe 92; Orb 88; Paid.ai 80** |
| 9 | End-customer billing / monetization | **60** | 20 | 10 | 15 | 30 | 32 | 5 | 10 | 5 | **Stripe 95; Orb/Paid.ai 82; Sierra 62** |
| 10 | Marketplace / distribution | **30** | 85 | 52 | 75 | 85 | 75 | 50 | 40 | 12 | OpenAI/MSFT 85 |
| 11 | Security / compliance | **66** | 75 | 85 | 88 | 92 | 90 | 70 | 58 | 65 | **MSFT 92**; AWS/Sierra/Cohere 90 |
| 12 | Multi-tenancy for agencies / resellers | **42** | 32 | 30 | 45 | 55 | 50 | 38 | 35 | 30 | **Stripe Connect 90**; Orb 68 |
| 13 | Model neutrality / BYOK | **78** | 10 | 28 | 62 | 65 | 85 | 95 | 90 | 90 | **LangChain 95**; Bedrock 85 |
| 14 | CLI & developer experience | **62** | 72 | 95 | 74 | 62 | 68 | 82 | 72 | 76 | **Anthropic 95**; Stripe 90 |
| 15 | Web UI / console maturity | **60** | 80 | 72 | 76 | 80 | 68 | 84 | 65 | 84 | **Stripe 92**; LangSmith/Braintrust/Glean 82–84 |
| 16 | Docs quality | **52** | 85 | 90 | 70 | 75 | 74 | 78 | 70 | 80 | **Stripe 94**; Anthropic 90 |
| 17 | Pricing model | **55** | 75 | 70 | 78 | 62 | 76 | 75 | 60 | 68 | **Stripe 85**; Google/AWS 76–78 |
| 18 | Ecosystem / mindshare | **8** | 93 | 90 | 85 | 87 | 76 | 87 | 70 | 60 | OpenAI/Stripe 93; Anthropic 90 |

**Oxagen mean ≈ 56** (agent-field peers cluster 62–72). The distribution is the story: Oxagen is bimodal — 70–78 on the four wedge dimensions (contracts, grounding, memory, neutrality) and metering/billing, but ≤42 on evals, marketplace, multi-tenancy, and 8 on mindshare. It is not "uniformly behind"; it is "deep where it chose to fight, empty everywhere it hasn't launched."

---

## 3. Per-dimension detail

**1. Agent orchestration / runtime — Oxagen 68 (leader LangGraph 90).**
A single well-engineered TS step-loop (`packages/agent-engine/src/engine.ts` `runCodingAgent`) drives both CLI and in-app chat: per-step deterministic compaction at 80% context, exponential-backoff retry, loop-detection nudges, deterministic tier routing (no extra LLM call), guarded subagent fan-out (depth 3 / width 100 / 250-descendant cap with lineage), and a self-improvement evaluate→judge→revise pipeline (agent-engine audit: flows 85). Real hosted runtime spans app + API + MCP + durable sandboxes (Docker/Modal/Vercel drivers). It loses to the leaders only on breadth (one engine, not a multi-language SDK) and zero production scale. **+10:** ship a per-workspace runtime-bounds config (maxSteps/timeout are hardcoded 256) and a public managed-runtime surface with SLAs.

**2. Tool / MCP ecosystem — Oxagen 48 (leader Anthropic 95).**
MCP is wired (connect at `/mcp`, 299 MCP tools, external-server registration + OAuth + envelope-encrypted creds), and the 308-capability native surface is large. But the *ecosystem* is empty (no third-party servers, no directory reach) and the integration audit scored skills+MCP 58 because the DB-backed platform contributor applies none of the rich allow/deny/visibility permission model the file/CLI path uses. **+10:** unify the two MCP permission planes (`packages/mcp-config/permissions.ts` → the DB `mcp.ts` path) and seed a governed public server catalog.

**3. Typed / governed tool contracts & policy — Oxagen 70 (leader MSFT Entra 80).**
This is the stated wedge and the code *partially* delivers it: every first-party capability is a typed contract routed through `invoke()`, which enforces IAM → billing admission → entitlement → handler → per-call audit (kernel fails closed on IAM eval error). No competitor binds identity+action+metering+entitlement+audit in one object with API/MCP/CLI/UI parity. **But** the headline "un-poisonable typed contract for *external* MCP tools" is not delivered — `readLatestSnapshots` has zero production callers, live tool descriptions are injected raw (no drift diff, no sanitization), and external inputs are discarded to `z.record(unknown)`; commercial-terms binding is uniform-at-kernel, not per-capability. That external hole and thin commercial binding keep it just under Entra's GA identity governance. **+10:** wire snapshot-diff drift detection + delimit/typed-validate external MCP tools, closing the poisoning gap the mission claims.

**4. Knowledge grounding / graph RAG — Oxagen 74 (leader Glean 90).**
Genuinely differentiated and one of the three moats. `packages/ontology` (Neo4j constraints + range + 1536-dim cosine vector indexes) plus engram's `context-compiler.ts` fuse temporal, vector-ANN, graph-structural, and lexical/BM25 retrieval under budget/diversity constraints; answers cite nodes by human label via `NodeRef`; a 23-capability schema registry governs the ontology with versioning/validation; semantic-edge inference is human-reviewable; RLS scopes the graph per tenant. This is the ontology-governed, cited, BYOK developer graph the dossier says is unclaimed (Glean is closed/search-shaped, Writer quota'd, AWS generic auto-extraction). Docked for no published accuracy benchmark, thin node-browse UI, and no scale proof. **+10:** publish a GraphRAG accuracy benchmark and ship real node browse/search UI (the `nodes` route currently redirects away).

**5. Memory — Oxagen 72 (leader AWS 85).**
A managed AgentMemory graph with full CRUD + promote, a governed decay policy (per-weight half-lives, recall/compliance thresholds, decay floor), two-axis memory (class+kind), citations/evidence/promotions, and human-confirmed promotion to RULE/FACT. Richer on *governance* than the metered-memory leaders, but unproven at scale and citations/promotions have no review UI. **+10:** surface the memory-citation/evidence/promotion review queue in-app and prove recall quality.

**6. Evals & testing — Oxagen 40 (leader Braintrust 95).**
Eight `eval.*` contracts exist (dataset create / from-traces / item.add, run start/status/get) and the CLI covers the write path, but the app Evals surface is **read-only and a true nav orphan** (2 unlinked pages, no create/run affordances) and there is no online-eval or LLM-judge-at-scale product. `eval.dataset.from_traces` (build datasets from already-metered runs) is a nice vision-aligned hook. **+10:** wire the eval write path into the app and link the surface into nav/Activity.

**7. Observability / tracing — Oxagen 62 (leader LangSmith 92).**
Real per-execution tracing is live: Activity pages render span-tree traces backed by ClickHouse (token_usage, tool_invocations, error_events) with `captureError` wired at 4 boundaries. The former `agent.execution.lineage` file-touch graph was retired because its generic client-authored projection could not provide verified provenance; durable execution trace remains, and exact file evidence belongs in a future immutable evidence ledger. It supports the "fleet lineage" pillar but has no OTel-export product and no scale. **+10:** ship OTel export and the typed evidence-ledger ingest.

**8. Usage metering & cost tracking — Oxagen 72 (leader Stripe 92).**
Mature and vision-central: every `invoke()` meters to ClickHouse with cached-token repricing and provider cost; `billing.usage.breakdown` renders per-model/surface/workspace cost; prompt text is hashed (privacy) while raw stays in Postgres; a solved-margin markup turns provider cost into credits. Docked because the pre-turn credit admission gate (`hasCreditBalance`/`assertCanStartTurn`) is defined but **not wired into the chat route** (zero-balance free-ride) and there is no agent-path rate limiting. **+10:** wire the pre-turn 402 admission gate and a distributed rate limiter on the agent endpoints.

**9. End-customer billing / monetization — Oxagen 60 (leader Stripe 95).**
The single most-differentiated dimension vs the agent field (all ≤32). A real, complete Stripe surface exists in `packages/billing`: subscriptions, credit lots/balances, checkout, credits-purchase, auto-reload, dunning, disputes, invoices, payment methods, seats/proration, discount, webhooks, plus `stripe-sync` reconciling products/prices to a solved blended-margin target. This genuinely turns observed usage into customer billing **for the platform's own customers**. It is *not* the agency layer the "resell" mission implies — billing UI is single-org-scoped, with no Connect-style sub-accounts, split payouts, or an org re-invoicing its own end-customers — which is why it sits well below Stripe/Orb/Paid.ai. **+10:** build the reseller/agency tier (per-customer meters, sub-account invoicing, margin control) — the actual wedge.

**10. Marketplace / distribution — Oxagen 30 (leader OpenAI/MSFT 85).**
The `marketplace/agent-tools` install catalog (skills/MCP/capabilities via `plugin.org.install`) and connector registry are real UI, and plugin packs exist, but there is zero reach, no monetized third-party store, and one fictional binding (`install_plugins_bulk` UI discards the action). **+10:** a monetized third-party plugin/connector marketplace with revenue share — but per VISION this is a fast-follow, not the front line.

**11. Security / compliance — Oxagen 66 (leader MSFT 92).**
Strong controls-in-code: sandbox hardening (CapDrop ALL, seccomp, readonly rootfs, non-root, Firecracker prod tiers), layered env denylist, fail-closed IAM+entitlement, HITL approval, CI-enforced RLS with `FORCE ROW LEVEL SECURITY`, MFA, keyset audit-log viewer, signed audit export, session/access-review evidence (CC6.1/6.3). Docked hard for no third-party attestation (pre-launch), a **mutable Postgres audit sink with no WORM/hash-chaining** and fire-and-forget `emitSecurityEvent` (CC7 exposure), and org-wide MFA/SSO enforcement + backup-restore drill not built. **+10:** WORM/hash-chain the `security_events` sink and land a SOC 2 Type II attestation.

**12. Multi-tenancy for agencies / resellers — Oxagen 42 (leader Stripe Connect 90).**
Tenant *isolation* engineering is strong (org/workspace two-level RLS, IAM, per-workspace IDOR gates verified in routes-inventory), but that is team multi-tenancy, not the agency-bills-its-customers model the mission needs — no customer-tenant object, no sub-account hierarchy, no cross-org reseller console. The dossier notes every agent platform treats this as an afterthought (≤55), so the ground is open. **+10:** a customer-tenant / sub-account model beneath the workspace, wired to the billing agency tier (dimension 9).

**13. Model neutrality / BYOK — Oxagen 78 (leader LangChain 95).**
Neutral by construction and a stated trust moat: `modelIdOf()` resolution, the AI Gateway, `OXAGEN_LLM_{FAST,BALANCED,PRECISE}` tier→slug env swap, all LLM calls forced through `@oxagen/ai` re-exports, hard-coded slugs lint-banned. Below LangChain only on proven provider breadth and pre-launch. **+10:** document and test the BYOK provider matrix + self-host path publicly to convert design-neutrality into proven neutrality.

**14. CLI & developer experience — Oxagen 62 (leader Anthropic 95).**
35 Commander+Ink command modules (graph push/pull/search, fleet, sandbox, eval, memory, agent, secret, `oxagen dev`) with contract→API→MCP→CLI parity discipline. Docked for unproven DX adoption and doc staleness (a broken clone URL and stale ADR-025 tool names in the install guide). **+10:** fix the install-guide breakages and add a polished onboarding/quickstart with proven first-run success.

**15. Web UI / console maturity — Oxagen 60 (leader Stripe 92).**
Substantial: 84 pages, 61 real content pages, most fully wired (ask, knowledge, activity, studio, billing, security, settings). Docked for the 2 orphan Evals pages, a mis-keyed `capability-ui-map.json` (43 forward "gaps" that are mostly a key-naming bug, +2 genuine, +1 fictional binding), 41/56 bindings lacking runtime proof, a stale command menu, a latent sidebar 404, and systemic reverse-parity drift. **+10:** fix the parity-map keying + orphan Evals + command-menu staleness, and attach runtime proof to the bindings.

**16. Docs quality — Oxagen 52 (leader Stripe 94).**
Decent structure (~105 Fumadocs pages, strong CLI section, good getting-started/index) undercut by ADR-025 rename fallout (18+ pages with stale dotted capability names, a broken clone URL, a broken anchor), **zero user-facing narrative for 15 domains including billing — the wedge itself** — and public exposure of internal specs that admit a "3x overcharging bug" and contradict their own pricing tiers. **+10:** write `billing/overview.mdx` + `knowledge/*` and run the ADR-025 naming sweep.

**17. Pricing model — Oxagen 55 (leader Stripe 85).**
The *mechanism* is clean and vision-aligned (1 credit = $0.01, subscriptions + credit packs, solved blended-margin markup, per-turn budget governance, auto-reload, dunning). But there is no shipped public pricing page (the marketing site is an investor deck) and the only pricing docs are archived internal specs that contradict each other (Starter $50/Growth $200/Scale $600 vs Pro $20/Scale $99). **+10:** publish one reconciled public pricing page backed by the `pricing.ts` source of truth.

**18. Ecosystem / mindshare — Oxagen 8 (leader OpenAI/Stripe 93).**
Pre-launch: no users, community, GitHub presence, partner network, or third-party content; the public site is a static deck. This is correctly near the floor and will only move with launch, adoption, and proof — not code. **+10:** ship, get real logos/usage, and publish the graph-grounding + metering-to-billing proof points that anchor the wedge.

---

## 4. Strategic read

**Wide open (no credible integrated owner — attack here):**
- **Governed-usage → customer-invoice from inside a governed runtime.** Stripe/Orb/Paid.ai own the rails but are blind to runtime; platforms meter only their own bill. Oxagen already has the metering (72) + billing loop (60) + governed kernel (70) — the missing 40% is the agency/reseller layer (dim 9 + 12), the highest-leverage build in the whole matrix.
- **The full accountability chain as one enforced object** — identity→knowledge scope→action→commercial terms→verified outcome→audit. Oxagen's `invoke()` binds most links for first-party capabilities today; MSFT/AWS/Stripe each own one link. Closing the external-MCP poisoning gap (dim 3) makes this claim true and un-forgeable.
- **Neutral, developer-first ontology graph grounding** (dim 4, 74) — Glean is closed, Writer quota'd, AWS generic, Anthropic a DIY cookbook. Oxagen's is the only ontology-governed, cited, BYOK developer graph; it just needs a published benchmark and browse UI.
- **Agency/reseller multi-tenancy** (dim 12, 42) — every agent platform ≤55; open ground for an agency-first control plane.

**Dominated (do not fight head-on — fast-follow only):**
Orchestration frameworks (LangGraph 90), evals (Braintrust 95 / LangSmith 85 — even OpenAI retreated), tracing (LangSmith 92), MCP-ecosystem breadth (Anthropic 95, Glean gateway), managed runtime+memory scale (AWS/Google/MSFT), raw billing rails (Stripe post-Metronome, Adyen post-Orb), consumer distribution (OpenAI 900M WAU), agent-identity rails (MSFT Entra), CLI mindshare (Claude Code 95).

**Five highest-leverage investments (ranked):**
1. **Build the reseller/agency billing + tenancy layer** (dims 9, 12) — converts a strong *platform-billing* loop into the actual "Stripe-for-agents" wedge no one else has. Highest strategic ROI.
2. **Close the external-MCP poisoning gap** (dim 3) — wire snapshot-diff drift detection + typed/sanitized external tool I/O; makes the "un-poisonable contract" claim true and defensible.
3. **Wire the pre-turn credit admission gate + agent-path rate limiting** (dim 8) — closes the zero-balance free-ride and abuse surface; a correctness precondition for monetization credibility.
4. **Publish the graph-grounding proof + billing narrative** (dims 4, 16) — a GraphRAG accuracy benchmark and a `billing/overview.mdx`; turns two silent moats into marketable, verifiable claims.
5. **Harden the audit sink and land SOC 2 Type II** (dim 11) — WORM/hash-chain `security_events`; enterprise resellers cannot buy governance infrastructure whose own audit trail is mutable and fire-and-forget.

---

## Method & caveats

- **Point-in-time (July 2026).** The agent market is moving weekly (AgentKit deprecation Nov 2026, Stripe/Metronome Jan 2026, Adyen/Orb June 2026); these scores decay fast.
- **Competitor scores** come from web research compiled in `scratchpad/findings/competitors.md`, with primary/secondary sources cited inline there; they are third-party maturity estimates, not audits of competitor code.
- **Oxagen scores are derived from a static code audit of this repository, not from production usage.** Every axis that depends on scale, adoption, certification, or real-world proof (mindshare, security attestation, benchmark-backed grounding, DX adoption) is discounted for pre-launch status; a live deployment could move several dimensions up or reveal defects that move them down.
- **Scoring is comparative maturity, 1–100, not a pass/fail bar.** Oxagen's wedge scores (contracts/grounding/metering/billing/neutrality) are deliberately calibrated to what the code *delivers today*, not to the VISION's aspiration — the external-MCP gap, unwired admission gate, single-tenant billing, and orphaned eval UI are all reflected as dock, not glossed.
