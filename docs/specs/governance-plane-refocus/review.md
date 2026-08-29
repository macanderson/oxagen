# Governance-plane refocus — codebase review and cut plan

**Status:** Proposed (strategy review, not yet an ADR)

**Date:** 2026-08-28

**Question answered:** Can Oxagen reposition as a pure governance plane — the
system that certifies, permissions, observes, meters, and audits *any* agent
(Stella or third-party), shipping a wrapper that makes foreign agents look like
Stella in observability, permission-requesting, and Context Graph Protocol
conformance — and what code should be cut to get there?

**Verdict: yes, and the codebase is much closer than the surface area
suggests.** The governance kernel is already engine-agnostic, the external-agent
seams are already designed (several are live), and the agent-execution platform
is cleanly separable. The work is roughly one-third deletion, one-third
extraction (to Stella / a separate engine product), and one-third building the
one genuinely missing product: the external-agent wrapper + evidence ingress +
an approvals-first UI.

---

## 1. What the review found

Three full-codebase surveys (frontend, capability contracts, packages) produced
these headline facts:

### The governance plane already exists and is engine-agnostic

- The kernel gate chain (`packages/oxagen/src/kernel.ts`: IAM → billing
  admission → budget ceiling → entitlement → tenant scope → handler → audit +
  metering) never imports the agent engine. Gates are injected at bootstrap.
- Every one of the 335 registered contracts carries `defaultEffect: "deny"`,
  `sensitivity`, risk level, and `agent.requiresApproval` (61 contracts require
  human approval today). Approval/consent resolution is live
  (`agent.approval.resolve`, `agent.mcp_consent.resolve`, PG-NOTIFY resume).
- `packages/compliance` single-sources the SOC2 security-event taxonomy and
  *generates* the Postgres CHECK constraints, so schema, emitter, and migration
  cannot drift. Every kernel dispatch emits `capability.invoke_allowed|denied|error`.
- `authorizeExternalCapability()` (`kernel.ts:1387`) already policy-checks
  synthetic capability ids (`mcp.<server>.<tool>`) with no registered contract —
  the generic "govern a thing we don't own" primitive, live behind external MCP
  tools.

### The agent runtime is barely entangled

- `packages/agent-engine` (14.4k LOC) has **zero `@oxagen/*` dependencies**.
- All four execution surfaces (app chat stream, api chat stream, A2A bridge,
  `agent.repo.edit`) converge on one 61-line file,
  `packages/agent-runner/src/execute-turn.ts`, whose own header says the engine
  swap happens "HERE, without touching any surface."
- `packages/agent-runner` is misnamed: ~94% of it is run identity, fenced
  immutable attempts, lease tokens, the append-only event log, authorization
  snapshots, and finalization grants — i.e. the evidence store, which is
  governance-core and stays.
- Residual entanglements are small and already documented: move
  `digestOfCanonicalJson` from `agent-runner` into `@oxagen/run-evidence`
  (severs the `iam → agent-runner` edge), and lift `agent-engine/src/router/`
  (1,082 LOC of routing *policy*) into governance before extracting the engine.

### The external-agent seams are designed, several are live

- **Live:** Stella operational-telemetry ingress
  (`telemetry.stella.ingest` — enrollment-scoped API keys, content-free usage
  rollups, tenant stamped server-side into ClickHouse). This is
  metering-an-external-agent, shipping today.
- **Live:** A2A v1.0 transport (`apps/api/src/routes/a2a/`) with
  `/.well-known/agent-card.json` discovery — currently pointed *inward* at the
  local engine, and (per `docs/specs/a2a-agent-identity/spec.md`) still
  anonymous/lineage-less.
- **Approved spec, half-built:** `docs/specs/run-evidence-ingress/spec.md`
  defines `RunEvidenceEnvelopeV1` (producer payload) vs `RunEvidenceManifestV1`
  (Oxagen-stamped immutable record), and — critically — distinguishes
  `runner_observed` (hosted) from **`client_attested`** (standalone/third-party
  agent) evidence authority. `RunSpecV2`, fenced attempts, and
  `finalization-grant.ts` exist; **the `ingest_run_evidence` capability itself
  is not yet a registered contract** and `packages/run-evidence` (CGP
  conformance via the official `@contextgraphprotocol/typescript-sdk`,
  RFC-8785 canonical digests with prototype-pollution hardening) has zero
  consumers.
- **Dormant:** `packages/stella-engine-client` — an HTTP+SSE reverse-RPC
  transport where Oxagen is the *host* (supplies every model completion and
  tool result) and the external engine only orchestrates. Zero production
  consumers, but it is exactly the govern-an-external-engine posture.
- **Already written down:** ADR-034 / `docs/specs/customer-capabilities/` —
  whose running example is agents *on a non-Oxagen platform* calling governed
  capabilities via the workspace MCP endpoint.

### The mass to cut is real and mostly low-blast-radius

- `apps/app`: ~131k LOC (~52%) is agent-platform (chat 60.5k, workbench 27.2k,
  chat-stream API 8.1k, automations 7.4k, evals 5.6k, sandbox components 5.1k,
  agent-defaults 4.5k, …) vs ~62k governance-core and ~53k shared infra.
- Contracts: ~135 of 335 (~40%) are agent-execution; ~75 are cleanly cuttable
  (sandbox, browser, code, subagent fan-out, background tasks, file locks,
  content generation, skills authoring, evals). Capability parity means each
  cut also removes ~4 surface files (API route, MCP tool, CLI command, UI).
- Packages: `bench` (1.6k) and `replay` (1.3k, CLI-only) and `prompt-templates`
  (0.8k) are deletable now; `agent-engine`, `agent-worker`, `sandbox`,
  `skills`, `code-graph` (~19.7k combined) are extractable to the Stella side.
- `apps/cli`: ~114k LOC, of which `repl/` + `agent/` + `tui/` ≈ 61k is a
  terminal coding agent — i.e. Stella's job, duplicated in TypeScript.

### The single most important structural finding (frontend)

The four most on-brand governance widgets in the product — the **approval
card, consent card, risk badge, and execution/activity timeline** — exist
*only as inline cards inside a chat transcript*
(`apps/app/src/components/chat/`). There is **no standalone "pending
approvals" page anywhere in the app**. The crown jewels of the governance
story are trapped inside the biggest cut candidate. Extraction is therefore
the first move, and it decouples the keep-list from the cut-list.

---

## 2. Pushback — where the story needs honesty or narrowing

**(a) A wrapper can only attest what it observes.** "Make any agent look like
Stella" has two enforcement tiers, and conflating them will lose enterprise
security reviews:

1. **Gateway-enforced (strong).** The agent's tools, credentials, and model
   keys live behind Oxagen (governed MCP endpoint, Oxagen-issued scoped
   credentials, sidecar-host transport). Oxagen can actually *block* — deny,
   require approval, meter pre-spend. This supports the "program the refund
   rules, Oxagen makes sure no agent screws it up" claim.
2. **Client-attested (weaker).** An SDK inside someone else's agent emits
   evidence. Oxagen can prove what was reported and detect tampering/gaps, but
   cannot prevent an ungoverned side channel. The approved spec already
   encodes this honestly as `client_attested` authority with replay grades —
   "missing evidence lowers the replay grade; it never disappears silently."

The dashcam analogy survives this — a dashcam the driver can unplug still cuts
premiums, because unplugging is itself visible evidence. But sell tier 1 as
enforcement and tier 2 as attestation; never claim prevention where you only
have observation. The insurance-grade claim is *tamper-evident completeness*,
not omniscience.

**(b) The insurance/certification story is a business layer, not a codebase.**
Reduced-premium positioning requires an actuarial counterparty (insurer, broker,
or captive) willing to price against Oxagen evidence. Nothing should be built
for it beyond what SOC2 + evidence export already requires until a design
partner exists. The code target that makes the story *possible* is: immutable
manifests, agent identity + version binding (ADR-024 `agentKey` already gives
the certifiable identity string), authorization snapshots, and an auditor-grade
evidence export. Certification tiers, scorecards, and premium models are GTM.

**(c) Don't kill chat; demote and slim it.** Chat is the app's spine: the Ask
bar is mounted in the global shell, `lib/page-context/` is fed by nearly every
page, and the form-fill protocol touches 7 unrelated forms. Wholesale deletion
is a rewrite of the shell. More importantly, "ask what your agents did, what
context they had, what they touched" — graph-grounded Q&A over audit, lineage,
and evidence — is squarely on-vision and is the natural query surface for a
governance product. Recommendation: keep one slim conversational surface
re-scoped from "chat with the coding agent" to "interrogate the fleet record";
cut the coding-agent generative-UI registry (code-diff, terminal-trace,
research-swarm, media generation ≈ 8k of 15.8k) and the in-process coding loop
behind it.

**(d) "Govern any agent" must not become connector breadth in a costume.** The
temptation will be deep bespoke integrations per framework (LangGraph,
CrewAI, OpenAI Agents, AutoGen, …). That is the drift VISION.md already bans.
Keep the integration surface to **one protocol + thin shims**: the evidence
envelope (CGP-conformant), the governed MCP endpoint, A2A, and at most 2–3
reference shims (e.g. a Claude Code hooks adapter, an OpenAI-Agents
middleware) maintained as examples, not products.

**(e) One real tension with VISION.md.** The vision says "teams that build and
resell AI agents"; this repositioning sells to *enterprises adopting anyone's
agents*. These are compatible — the reseller metering loop becomes
chargeback/showback + insurance-grade cost attribution for enterprises — but
the vision doc should be amended so the Vision Gate doesn't judge the wrapper
work as drift. The accountability-chain language in VISION.md already *is*
this product; the amendment is deleting the implicit "and we also run the
agents."

**(f) Revenue reality check.** Today, billing meters agents Oxagen executes.
After the cut, metering must ride on evidence ingress and the gateway path —
which the Stella telemetry ingress already prototypes (`cost_microusd` rollups
from an external agent). This is a strengthening move (billing survives the
engine leaving), but it must be sequenced *before* the in-process engine is
removed, or the meter goes dark.

---

## 3. Disposition — keep / extract / delete

### Keep and deepen (the product)

| Asset | Where |
|---|---|
| Kernel + gate chain, contracts registry | `packages/oxagen` |
| IAM, authorization snapshots, dual-principal agent runs | `packages/iam` |
| Run identity / attempts / event log / finalization (rename: this is the evidence store, not a "runner") | `packages/agent-runner` minus `execute-turn.ts` |
| CGP conformance + canonical digests | `packages/run-evidence` (promote from orphan to spine) |
| SOC2 taxonomy + drift-proof audit | `packages/compliance`, `packages/telemetry` |
| Metering→Stripe, budgets, reseller rebill | `packages/billing` |
| Entitlements, credentials/KMS, secrets | `packages/plugins`, `secret.*` |
| Tool-wrapping governance runtime (IAM → entitlement → RBAC → consent → approval → telemetry per tool call) — this *is* the wrapper, currently welded to the in-process ToolSet | `packages/agent/src/runtime/` (~4k LOC: `materialize-tools.ts`, `approval.ts`, `consent.ts`, mcp-rbac) |
| Knowledge graph, ontology, ingestion, memory-policy/citation/evidence contracts | `packages/ontology`, `packages/ingestion`, `packages/engram` (policy/citation half) |
| A2A transport + agent identity (`agentKey`, ADR-024) | `apps/api/src/routes/a2a/`, identity schema |
| Stella telemetry ingress | `telemetry.stella.ingest` path |
| App: governance hub, security/audit, access reviews, billing/usage, members, tokens, knowledge, overview HUD, lineage, spend budgets, effective-scope panel | `apps/app` (~62k LOC) |

### Extract to the Stella / engine side (~19.7k pkg LOC + ~61k CLI LOC)

`agent-engine` (after lifting `router/` into governance), `agent-worker`,
`sandbox`, `skills`, `code-graph`; `apps/cli`'s `repl/`, `agent/`, `tui/`,
and the execution command modules (`fleet`, `solve`, `code`, `sandbox*`,
`init-engine`, …). Keep a thin `oxagen` CLI for governance ops: auth, budget,
cost, trace, lineage, secret, telemetry, memory, graph search.

### Delete outright

- Packages: `bench`, `replay` (or move to Stella), `prompt-templates`.
- App routes (whole directories, low blast radius, ~52k LOC): `workbench/sandboxes`,
  `workbench/repos`, `workbench/environments`, `workbench/tools/skills`,
  `evals/`, `marketplace/`, `automations/` (minus `lineage/`),
  `settings/agent-defaults/`, `components/sandbox/`, the code-execution subset
  of `components/chat/registry-components/`.
- Contracts (~75, each removing ~4 surface files via parity): `agent.sandbox*`,
  `sandbox.template.*`, `browser.*`, `code.*`, `agent.code.execute`,
  `agent.subagent*`, `agent.background_task.*`, `agent.file_lock.*`,
  `agent.plan.*`, `skill.*`, `agent.skill.*`, `eval.*`, `research.swarm.*`,
  content generation (`image.*`, `video`, `svg`, `mermaid`, `markdown`,
  `document.*`, `form.fill`, `archive.create`), `prompt.settings.*`,
  `workflow.*`/`automation.*` (execution half).
- Borderline, decide per-contract: `repo.*` (keep connection/sync/CI-status as
  grounding + evidence corroboration; cut `repo.file.put`-style execution),
  `conversation.*` (keep `purge`/`export` for retention/DSAR),
  `agent.definition.*` (keep as the **registry of governed agents** — repurpose
  from "author an agent" to "register/certify an agent"), `agent.memory.*`
  (keep policy/citation/evidence; working-memory CRUD goes with the engine).

---

## 4. Build plan

**Phase 0 — decide and de-risk (days).**
ADR for the repositioning; amend `docs/VISION.md` (§2e above); pick the two
launch integration shims. Gate: Vision Gate green on the amended vision.

**Phase 1 — carve out (1–2 weeks of focused work).**
1. Extract approval/consent/plan cards, activity timeline, risk badge,
   budget-control out of `components/chat/` into `components/governance/`.
2. Sever the two package edges (digest → `run-evidence`; `router/` →
   governance). Rename `agent-runner` → evidence store.
3. Delete the wholesale-deletable routes, components, packages, and ~75
   contracts (+ their API/MCP/CLI surfaces, sidebar/routes/breadcrumbs
   entries, and e2e specs).
4. Move `agent-engine`/`agent-worker`/`sandbox`/`skills`/`code-graph` and the
   CLI execution core out (separate repo or a clearly-fenced `engine/`
   workspace pending Stella convergence per ADR-033).

**Phase 2 — the wrapper (the new product; the only genuinely new build).**
1. **`ingest_run_evidence` contract + hosted finalizer** — finish the approved
   spec's first slice (`runner_observed`).
2. **`client_attested` ingress** — enrollment-keyed (pattern already live in
   Stella telemetry ingress), evidence-graded, fail-visible. This is the
   "wrapper SDK" server side.
3. **Governed gateway** — generalize `authorizeExternalCapability()` +
   `packages/agent/src/runtime/` into a transport-neutral tool gateway:
   external agents get Oxagen-issued scoped credentials and call tools through
   the workspace MCP endpoint; every call gets IAM → entitlement → consent →
   approval → metering → audit. ADR-034 customer capabilities ride on this.
4. **External agent identity** — extend ADR-024 `agentKey` + agent registry to
   third-party agents (register, version-bind, enroll, revoke). A2A gains
   per-agent identity and lineage (closing the gap its own spec documents).
5. **Wrapper SDKs (thin):** TypeScript SDK speaking the evidence envelope +
   CGP frames + approval-request API; two reference shims.
   `stella-engine-client`'s reverse-RPC host pattern is the strong-tier
   transport for engines that support it.

**Phase 3 — approvals-first UI.**
`/approvals` org-level queue (backed by existing resolve actions); agent
registry / fleet page (per-agent "flight recorder": identity, version,
authorization snapshot, run timeline, context manifests, spend); evidence
export (auditor packet); policy programming surface (the "refund rules" page:
approval thresholds, budget ceilings, capability grants — AI-assisted per the
`ai-assisted-config` pattern). Re-scope Ask to fleet interrogation.

**Phase 4 — certification & insurance (GTM-gated).**
Scorecards, certification tiers, insurer-facing exports — only with a design
partner. Code prerequisite is Phase 2/3, nothing more.

---

## 5. Feasibility answer

Possible — and structurally cheap relative to appearances, because the
governance plane was built engine-agnostic from the start and the external
seams were specced before this review asked for them. The genuinely new
engineering is Phase 2 (evidence ingress + gateway + identity for foreign
agents), most of which has an approved spec, existing DB tables, and live
prototypes. The genuinely hard parts are not code: keeping the wrapper claim
honest across the two enforcement tiers, resisting per-framework connector
sprawl, and landing the insurance story with a real counterparty.
