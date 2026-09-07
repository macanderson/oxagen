# ADR-043: Excise the agent runtime — Oxagen governs agents, it does not run them

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** ADR-040 (governance-plane refocus — this ADR executes its
  Phase 1 in one cut), ADR-033 (Stella engine core — superseded on the
  "embed the engine" point), ADR-007/ADR-011 (sandbox drivers — retired),
  ADR-008 (skills — retired), ADR-010 (subagent fan-out — retired),
  ADR-019 (unified agent engine — retired), ADR-028/029/030 (replay,
  mutation verifier, speculative tools — retired; Stella owns them),
  `docs/specs/tacho/` (the Stella-side seam), `docs/audits/2026-09-07-governance-plane-cut.md`

## Context

ADR-040 decided that Oxagen is an engine-agnostic governance plane and
scheduled the removal of the first-party runtime over a phased window. The
window did not close: at the time of this ADR the repository still carried
~800k lines of TypeScript across 36 packages and 8 apps, of which roughly
half was an agent *runtime* — a sandbox layer (Docker / Modal / Vercel), a
coding pipeline (`agent-engine`), a durable worker that claimed and executed
runs, a Stella sidecar transport that made Oxagen the host process of a Rust
engine, subagent fan-out, background tasks, file locks, plans, skills
authoring, evals, playbooks/automations, browser automation, content
generation (image / video / svg / mermaid / document), and a 47k-line CLI
that duplicated a terminal coding agent in TypeScript.

Stella (`macanderson/stella`) is the coding agent and the reference
implementation of CGP and of the trace vocabulary. Every one of the surfaces
above either duplicates Stella or exists only to run an agent inside Oxagen.
Carrying them has three compounding costs: the kernel's governance
guarantees are diluted across execution code paths that bypass them, the
schema accretes execution-state tables with no evidence value, and every
enterprise trust review has to reason about a runtime the product no longer
sells.

## Decision

1. **Delete the runtime, in one cut, on one branch.** No extraction to a
   sibling repository: Stella already implements everything worth keeping
   (its engine core, sandboxing, skills, verification ladder, replay), and
   the Oxagen-side copies diverged from it months ago. Anything below is
   recoverable from git history at `9711041769218ab6f8ed2b63b33e77aa5ecd5b83`.
   - Packages removed: `agent-engine`, `agent-worker`, `sandbox`, `skills`,
     `agent-artifacts`, `stella-engine-client`, `web` (search/fetch tools).
   - Apps removed: `web2` (undeployed duplicate of the marketing site).
   - `agent-runner` → **`run-ledger`**: the durable run / attempt / event /
     seal / finalization-grant store stays (it is the evidence ledger of
     `docs/specs/run-evidence-ingress`); `execute-turn.ts`, the Stella
     sidecar adapter, and the v1 legacy run spec go.
   - Contract families removed, with their API routes, MCP tools, CLI
     commands, handlers, Inngest functions, app pages, e2e specs and docs:
     `agent.sandbox*`, `sandbox.template.*`, `agent.code.execute`,
     `agent.compose`, `agent.feature.verify`, `agent.repo.edit`,
     `agent.subagent*`, `agent.background_task.*`, `agent.file_lock.*`,
     `agent.plan.*`, `agent.skill.*`, `skill.*`, `agent.ui.render`,
     `browser.*`, `code.*`, `form.fill`, `archive.create`, `image.*`,
     `video.generate`, `svg.generate`, `mermaid.generate`,
     `markdown.generate`, `document.*`, `research.swarm.*`, `web.*`,
     `eval.*`, `automation.*`, `workflow.*`, `a2a.card.get`, and the
     repository *mutation* half of `repo.*` (`create`, `fork`, `file.put`,
     `pr.open`, `branch.create`).
   - Tables dropped (Postgres): `agent.skills`, `agent.skill_versions`,
     `agent.background_tasks`, `agent.subagent_fanouts`,
     `agent.subagent_runs`, `agent.sandbox_sessions`, `agent.agent_plans`,
     `agent.file_locks`, `agent.file_lock_fences`,
     `agent.agent_run_checkpoints`, `agent.agent_run_attempt_leases`,
     `environments.sandbox_templates`, `environments.sandbox_template_tools`,
     `eval.*`, `workflow.*`, `content.*`, `cms.*`, `ai.batch_jobs`,
     `ingestion.governed_repository_selections`.
2. **The in-app agent stays, and it is not a coding agent.** Oxagen keeps
   one conversational surface whose job is to interrogate the fleet record
   and the knowledge graph: what did my agents do, what context did they
   have, what did it cost, what is pending approval. It runs as a thin
   in-process governed turn loop (`@oxagen/agent` `runGovernedTurn`) over
   `@oxagen/ai` (metered) with tools materialised from capability contracts
   through `kernel.invoke()`. It has no sandbox, no file system, no browser,
   no subagents. Stella is not embedded as a sidecar: a Rust engine
   supervised from a serverless function was an ops burden that bought
   nothing a governance Q&A agent needs.
3. **The evidence ledger, not the runner, is the trace of record.** Agent
   executions reach Oxagen through evidence ingress (`runner_observed` is
   retired with the worker; `client_attested` — Stella's drain and any
   wrapper SDK — is the path), through the governed MCP gateway for tool
   calls, and through operational telemetry. The witness-protocol
   pass/fail verdict rides on the trace as evidence; Oxagen stamps,
   grades, and rates — it never re-runs.
4. **Every remaining capability must serve one of five jobs**: govern
   (IAM, entitlements, approvals, budgets, tool RBAC), ground (graph,
   ontology, memory, context records, citations), explain (audit, lineage,
   traces, usage), meter/bill, or rate (trust scores from graded evidence).
   A capability that serves none of them is deleted on sight.

## Consequences

- The footprint roughly halves; the remaining packages form a DAG with
  `oxagen` (kernel) → `iam`/`billing`/`plugins`/`agent` → surfaces, and no
  package below the kernel imports an engine.
- Chat is briefly degraded: the coding generative-UI (diff cards, terminal
  traces, media) is gone and the turn loop is rebuilt as a governance
  agent. This is intended.
- ADR-007, 008, 010, 011, 019, 028, 029, 030, 033 are superseded. ADR-040's
  Phase 1 is complete; Phase 2 (evidence ingress contract, wrapper SDK,
  external agent identity) is the next body of work.
- Reseller billing continues to meter what the gateway and evidence
  ingress observe; the `runner_observed` attribution path is gone and
  `client_attested` is labelled as attestation, not enforcement (ADR-040 §4).

## Alternatives considered

- **Roll back to the multi-tenant/RLS baseline (`36660d2db`, 2026-06-06)
  and rebuild.** Rejected. That commit predates the billing→Stripe loop,
  the SOC2 security-event taxonomy, IAM principals and authorization
  snapshots, the evidence ledger, KMS-enveloped credentials, reseller
  rebilling and the knowledge/ontology surfaces — exactly the assets the
  governance product is made of. The runtime is separable by deletion;
  the governance core is not separable by rollback.
- **Extract the runtime to a new repository first.** Rejected: Stella is
  that repository, and it is ahead.
- **Keep the Stella sidecar as the in-app agent engine.** Rejected for
  now: it is the right transport for a hosted coding agent, which Oxagen
  no longer is. It can return behind `run-ledger` if a hosted Stella
  product is ever built.
