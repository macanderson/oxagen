# Oxagen Mission Control: Product and Technical Specification

| | |
|---|---|
| **Status** | Draft for review |
| **Date** | 2026-09-11 |
| **Owner** | Mac Anderson |
| **Supersedes** | The `oxagen-platform` and `oxagen` codebases as products. Carries forward the designs named in §16. |
| **Builds on** | Context Graph Protocol `contextgraph/1.0` and the `contextgraph/lifecycle/1.0-draft` profile (repo at `origin/main`, ADRs 0001 to 0018). Stella's context-record and Context PR corpus. Oxagen ADR-024, 025, 042, 043, 051, 052, 053 and the current wrapper spec (in the repo today under `docs/specs/tacho/`, renamed here). |
| **Amended** | 2026-09-13, by Oxagen ADR-055 (`docs/adr/ADR-055-gau-buckets-and-contracted-rates.md`) and `apps/app/ARCHITECTURE.md` §3.9: the billing model. Blocks marked **Amendment 2026-09-13 (ADR-055)** supersede the text they follow in §0 row 13, §12.1, A.8, A.10 and Appendix E. |

---

## 0. The call sheet

This table lists every decision that shapes the rest of the document, in one place. Each decision is argued in its own section.

| # | Decision | Section |
|---|---|---|
| 1 | A build from scratch. One control plane, one language (TypeScript), one kernel. A control plane is the one system that sets and enforces the rules for every agent. Oxagen has one in-app agent. It handles onboarding, configuration, and questions over the fleet record. Its engine is **Stella serving over HTTP** in its own container. That engine holds no credentials and no authority. Every completion and tool call the engine needs comes back to Oxagen as a request, and Oxagen answers it. Model access for Oxagen's own work goes through **OpenRouter**. OpenRouter routes by tier to Z.AI GLM: the latest full model for complex work, and the flash model for classification and labeling. | §2, §4.4, §4.5, §16 |
| 2 | The organization is the tenant and the hard isolation boundary. A tenant is one customer whose data stays fully separate from every other customer's data. A workspace is a governance partition inside the organization: a section with its own rules, approvals, and ownership. This is the same model as today, with fewer tables. | §5 |
| 3 | Postgres tenant isolation uses Row-Level Security (RLS). RLS is a database feature that filters every row by rules tied to settings on the current transaction. There is **no bypass setting**. System access uses a separate database role with its own policy. | §5.2 |
| 4 | Neo4j isolation is **one database per organization**, and the engine enforces it. Workspace is a required property on the data, and a single graph service enforces that rule. | §5.3 |
| 5 | Three stores, not four. Postgres holds the control ledger. Neo4j holds the knowledge graph and the run record, and it is the source of truth. Object storage with write-once retention holds frame bodies and the archive. Write-once means a stored object cannot be changed after it is written. ClickHouse is retired. | §4 |
| 6 | Every wrapped agent passes through at least one of two gateway points where the agent connects to Oxagen: the **model proxy** and the **tool gateway**. Hooks and SDK adapters (the wrapper) add finer control. An SDK is a software development kit, the code library an agent is built with. Oxagen records the enforcement tier on every run, and the tier can never be over-stated. | §7 |
| 7 | Intervention is a defined contract: pause, resume, steer, cancel, revoke, approve, and inject. The guarantees are stated for each gateway point. Halting works by revoking credentials, not by asking the agent to cooperate. | §7.4 |
| 8 | A run is a hash-chained sequence of **frames**. A hash is a short fingerprint computed from data. A hash chain links each frame to the one before it, so no frame can be altered without detection. A frame is the replay unit. Frame metadata and cost live in the graph. Frame bodies are content-addressed, encrypted blobs. Content-addressed means each body is stored under the hash of its own content. | §8 |
| 9 | Agents learn by appending **context records** (the protocol's record kinds). They never learn by writing frames. Records are canonically hashed and countersigned. Canonical hashing puts a record in one standard form before hashing, so the same content always gives the same hash. Countersigned means a second party adds its own signature. | §9 |
| 10 | A workspace links to one or more GitHub repositories. Exactly one of them is its **main repo**, bound at creation. The main repo is the place where the workspace's steering and configuration are managed in source control. Published steering and every agent definition live there under `.oxagen/`. Stella reads that folder natively through a symlink, a file system pointer to another path. Oxagen mirrors the same folder into each coding harness's own agent format in the same pull request. Linked repos may carry repository-scoped records of their own. A **Context PR** is a GitHub pull request (PR), a proposed change that others review before it is merged. Merge is the promotion event. Nothing steers until it is published. The graph is the system of record. Git is the system of control, which is GitOps: steering changes are managed through git. | §10 |
| 11 | Oxagen infers ontologies from ingested sources. An ontology is the set of entity types and the relationships between them. Each ontology is proposed, reviewed, and activated as a versioned graph object. Entities carry provenance, a trace back to their source records. Linking a GitHub repo confirms its production branch, subscribes to every relevant event by webhook, imports its issues, and keeps a code graph of the production branch current on every push. A webhook is a call GitHub sends to Oxagen when an event happens. A manual sync is available, and there is no cron (a timer that runs jobs on a schedule). | §11 |
| 12 | Oxagen governs the toolbelt. An agent sees only the tools it is granted, and it can search them when the belt is large. The agent holds no credentials at all. Every call passes one pipeline: validate, taint-check, decide (allow, approve, or deny, deterministically), broker a per-call credential, dispatch idempotently, validate output, sign a receipt. A taint-check looks for data marked as untrusted or sensitive. Deterministic means the same input always gives the same decision. Idempotent dispatch means a repeated call has the same effect as a single call. A tool's safety classification describes the tool. The customer's approval rules decide, with auto-approval conditions Oxagen can apply to skip the human. Any consequence the customer marks (money, data destruction, production changes, external communication, access changes) requires a human-granted mandate. The mandate sets limits over the tool's declared measures and keeps a ledger. Kill switches exist at every level. Policy is versioned and simulated against real history before activation. An adversarial suite proves the guarantees per release. | §6.5–6.13 |
| 13 | Oxagen accounts customer spend per model call by normalized token class, including cache reads and writes. It attributes spend up the chain operator → agent → run → turn → step. It reports proven versus unproven spend with a productive ratio and ranked optimization findings. It reconciles spend to the cent against provider statements. Oxagen bills per run on a plan allowance and never marks up tokens. It reports governed actions and retained storage as secondary meters. **Amendment 2026-09-13 (ADR-055):** Oxagen bills governed action units (GAUs) from a monthly bucket on the subscription, sells more in unit quantities at the customer's contracted rate, and never marks up tokens; see §12.1. | §12 |
| 14 | Audit fidelity: **full bodies, seven years, write-once at seal time**. Seal time is the moment a record is closed and locked against change. Each organization has its own keys. Redaction happens before write. Erasure uses crypto-shredding: destroying the key so the encrypted data can never be read again. Frame nodes stay in the graph for a hot window. The run ledger stays forever. | §13 |
| 15 | Mission Control is ten pages: seven in a workspace and three for the organization, down from 70. Everything else is deleted. Appendix F says where each old route went. | §14, App. F |
| 16 | A run is proven only by a **witness** Oxagen wrote. A witness is a test built with one of several deterministic oracles, checkers whose result is fixed for a given input. The witness fails on the PR's target branch and passes on the PR. It runs in a witness runner the worker can never see or reach. The runner reports only pass or fail back to the worker. The flip from fail to pass stamps the run. Stamped runs are the training asset. | §8.5 |

---

## 1. Why this product, in one page

Companies rent intelligence by the token, the unit of text an AI model charges for. They cannot say what a token bought them. Their agents do not know the business. Nobody can limit them. Nobody can explain what they did. Nothing they learn is kept. The investor positioning names four jobs: **Teach, Govern, Explain, Learn**. This specification is the engineering shape of those four jobs as one product.

The wedge is narrow on purpose. A customer wraps the agents they already run (Stella, Claude Code, Claude Agent SDK agents, and custom agents). SDK means software development kit, a set of tools for building software. The customer then gets a mission control, one place to watch and direct every agent, that:

1. records every run frame by frame, with cost to the cent on every frame,
2. lets an operator watch, pause, steer, approve, and halt any run,
3. explains any decision by walking the chain: who asked, what the agent was told, what it did, what proved it, and what it cost,
4. turns what agents learn into reviewed, versioned steering (each change is numbered and kept) that lives in the customer's own repository,
5. teaches every future run from one knowledge graph, a linked map of the customer's data, built from the customer's data sources.

Owned intelligence (training a model per customer on proven runs) is the phase-three business. Nothing in this spec builds it. Nothing in this spec makes it harder, because proven runs are stored in the shape a training set needs.

**What this product is not.** It is not a coding-agent runtime, the system that runs an agent's code. It has no sandbox for agents, no file system, and no browser. A sandbox is an isolated space where code runs. It has no subagent fan-out, no skills engine, no evals harness, and no content generation. Subagent fan-out means one agent starting many helper agents. An evals harness is a test setup that scores agent output. No skills engine means Oxagen never runs a skill; the harness runs it. What Oxagen governs is **skill resolution**: which skills a workspace's `.oxagen/skills.toml` lets an agent find, which of them it may load, what that load cost, and what was held back and why. A skill is procedure written down — a file, in a repository, with a version and a digest. Resolution is the lookup that answers which of them an agent may see. That is the same cut as the toolbelt (§4.4), where Oxagen holds no credential and runs no tool and still decides every call (ADR-090). The one execution plane it operates is the witness runner (§8.5). An execution plane is the place where work runs. The witness runner runs proofs, never agents. ADR-043 already made that cut in the current repo. An ADR is an architecture decision record, a short written note of a design choice. This spec keeps that cut. Oxagen does have one **in-app agent**. It onboards a new organization (bind the repo, register the first agent, pick tools, set budgets). It helps configure the workspace afterwards. It answers questions over the fleet record and the graph. Its engine is Stella, running as a separate service over HTTP (ADR-053). HTTP is the standard web protocol. Its tools are agent tool contracts and nothing else (§4.4).

---

## 2. Scope

### 2.1 In scope for v1

- **Two renames, applied everywhere.** The current codebase uses the word *capability* for a registered contract with schemas, IAM defaults, and a handler. IAM is identity and access management, the system that decides who may do what. That contract is now called an **agent tool**. One registry holds Oxagen's own agent tools and the tools imported from MCP servers, APIs, and harnesses. MCP is the Model Context Protocol, a standard way for agents to reach outside tools. An API is an application programming interface, a way for one program to call another. A governed action is one top-level call to an agent tool. The current codebase uses the word *tacho* for the second thing, and that thing has no product name at all. It is simply **wrapping an agent**. In the SDK, the software development kit that developers use to call Oxagen from code, wrapping is `oxagen.agent.wrap({ ... })` in TypeScript and Python and `oxagen.Agent.Wrap(...)` in Go. All of these ship in one `@oxagen/sdk` package. In the CLI, the command-line tool, wrapping is `oxagen agent enroll | status | unenroll`. The runtime pieces are the `oxagend` collector, the `oxagen-hook` binary, and the `oxagen.frame/1.0` envelope. Neither old word appears in the product, the API, the UI (the user interface, the screens people work in), or the docs. Appendix E is the definitive list of agent tools that survive.
- **A free tier with the whole product in it, and one-click wrapping.** Every organization gets its first 1,000 runs each month free. Every governance feature is on for those runs (§12.1). Governance means the rules, approvals, and records that control what agents do. Wrapping Claude Code or Codex takes one click. That click runs a signed installer on macOS, Windows, or Linux (§7.2). Onboarding is three steps. The app does not open until an agent has talked to Oxagen (§4.4).
- Organizations, workspaces, members, invitations, roles.
- Agent identity, credentials, RBAC down to the tool version, and delegation ceilings. RBAC is role-based access control, where a role decides what each agent may do. A delegation ceiling means an agent can never do more than the person it acts for.
- The gateway. It includes the model proxy (the path each model call travels through), the tool gateway, the hook and SDK adapters, and the control channel.
- Run recording, the frame chain (the ordered, linked sequence of frames in a run), checkpoints (saved points a run can be restored from), attestation (a signed statement that a record is what it claims to be), replay in two forms (render and fork), and bisect between two runs (narrowing down the step where two runs start to differ).
- Cost ledger, price book, budgets, provider reconciliation (matching Oxagen's cost records against the provider's bill), and spend views.
- Knowledge graph per organization. It includes the ontology engine (the ontology is the set of entity types and the relationships between them), three connectors (GitHub, Linear, Postgres), entity resolution (deciding when two source records describe the same entity), and provenance (the record of where each fact came from).
- Context records, reflection, promotion, Context PRs (a PR is a pull request, a proposed change submitted for review), and steering delivery.
- Mission Control UI, API, MCP endpoint, and a thin CLI (`oxagen`) for enrollment and administration.
- Audit archive, retention, erasure, legal hold (keeping records past their normal deletion date because of a legal matter), and export.

### 2.2 Out of scope for v1

- Training pipeline, eval harness (an evaluation harness, a test rig that measures model or agent quality), model serving, and in-firewall installer (phase 3).
- Marketplace, installable plugins, reseller billing, A2A federation (agent-to-agent, where agents from different systems work together), and mobile parity (a mobile app that matches the full product).
- Workflows and playbooks. Automations. Chat as a product interface.
- Connectors beyond the three named. A connector SDK ships in v1 so partners can add more.

**Out of scope means out of the surfaces, not out of the tree.** Everything named
in §2.2 is de-registered for v1: its contract loses the layers and surfaces that
offered it, its route stops being reachable, and its page stops being routed.
None of it is deleted. The contract, the handler, the API route, the MCP tool,
the page, the components and the packages behind them stay on disk, keep
compiling and keep their tests. `DEREGISTERED.md` at the repository root is the
register of what has come off the surfaces and where its code still lives, and
`pnpm check:deregistered` fails the build if one of those paths disappears. A
scope decision is a statement about what we sell this release; it is not a
judgement that the code was wrong, and deleting on it would convert a reversible
call into an irreversible one. The only path from de-registered to deleted is an
ADR under `docs/adr/` that names the files.

### 2.3 Non-goals stated so they stay out

- No second permission system. IAM decides what is allowed. Every other part only attributes, meaning it records which agent or person an action belongs to without deciding permission.
- No second memory substrate, meaning no second store for what agents remember. Records are the memory model.
- No store of record that can be rebuilt from another store. Rollups (summaries computed from records) and indexes are allowed, and each one is labeled as such.
- No wire semantics of Oxagen's own, meaning no private rules for how data travels between systems. The protocol owns frames and records. Oxagen owns policy, storage, and product.

---

## 3. Vocabulary

This document uses each name exactly as defined here.

| Term | Meaning |
|---|---|
| **Organization** | The tenant, meaning one customer's own space in the system. An organization owns a Neo4j database, a key-encryption key (the key that protects other encryption keys), a Postgres partition, and a billing account. It may also own a dedicated data plane. |
| **Workspace** | A governance partition inside an organization, meaning a section with its own rules, approvals, and ownership. A workspace owns one **main repo** and any number of linked repos. It also owns one ontology (its shared model of concepts and how they relate), one steering set, a set of agents, tool grants, and budgets. |
| **Main repo** | The one linked repository where a workspace keeps its steering and configuration under source control (version-tracked file history). Every workspace has exactly one. |
| **Linked repo** | Any other repository that a workspace's agents work on. Oxagen loads it into the graph. It may carry steering records scoped to that one repository. |
| **Principal** | Anything that IAM makes a decision about. IAM is identity and access management, the system that decides who may do what. The three kinds are `human`, `agent`, and `service`. |
| **Agent** | A registered principal of kind `agent`. It has an immutable key, meaning a key that never changes, in the form `org_ns.ws_ns.slug` (ADR-024). It also has a harness type (the software that runs the agent) and credentials. Each agent has one identity. Identity is never per run. |
| **Operator** | The human accountable for an agent's runs. Every run has exactly one operator. That holds even when a schedule or a webhook (an automatic call from another system) started the run. In that case the operator is the person who owns that trigger. The IAM field is `initiating_principal`. The word people see is operator. |
| **Run** | One session of one agent under one operator, from start to stop, on one task. Claude Code and Stella call this a *session*. The run stores the harness's session id, and the two words mean the same thing. A resumed or forked run is the same run with a new attempt. The run is the unit of attribution (who gets credited or charged), billing, replay, and proof. |
| **Turn** | One prompt through to the point where the agent stops. The prompt can come from the operator, a schedule, or a resumed context. This is the same thing Claude Code and the OpenAI Agents SDK (software development kit, a library for building agents) call a turn. |
| **Step** | One model call or one tool call inside a turn. There are exactly two kinds of step, and no others. |
| **Model call** | One request to a model and the model's response. It carries usage counted by token class and a cost. OpenTelemetry (an open standard for activity data) calls this an inference span. |
| **Tool call** | One call to one tool version, with validated input and output. Every harness already uses this name. |
| **Frame** | One recorded event in a run. The frame is the replay unit. Each frame is hash-chained to the frame before it, meaning it stores a hash (a short fingerprint of data) of that earlier frame. A step produces one or more frames. A model call produces a request frame and a response frame. A tool call produces a requested frame and a result frame. A frame is distinct from a **context frame**. |
| **Context frame** | The protocol's atomic retrieval unit (`ContextFrame`), meaning the smallest piece of evidence the system fetches. It is evidence served into a prompt. Each context frame is typed, has a budget, and carries provenance (a record of where the evidence came from). |
| **Context record** | The protocol's immutable record (`ContextRecord`), one that cannot change once written. It holds what an agent or a person asserts, learns, proposes, or decides. There are twelve kinds. |
| **Steering** | Published directive and knowledge records that reach an agent during a run. |
| **Context PR** | A pull request (PR, a proposed change submitted for review) on the workspace repository. It proposes a change to steering. |
| **Governed action** | One top-level kernel call that passed IAM and the other gates, ran its handler, and wrote an audit record. The kernel is the system's core, a gate is a check a call must pass, and an audit record is a log entry of what happened. This is the billable unit (ADR-052). Invoices and the UI (user interface) show it as **action**. A governed action is something *Oxagen enforced*. A tool call is something *an agent did*. The two overlap only where an agent's tool call went through the tool gateway. A harness-native tool call under the harness tier is a tool call but not a governed action. Oxagen observed it but did not gate it. A denied tool call is recorded but is not a governed action. Denials are free. Some things are governed actions but are not the worker's tool calls. These include a human granting a role, a Context PR merge, a repo sync, an approval decision, and every call the in-app agent makes. |
| **Enforcement tier** | What Oxagen could enforce on a run in practice. The tiers are `gateway`, `harness`, and `observe`. |
| **Replay grade** | The strongest thing a person can do with a run's recording. The grade comes from gaps in how complete the recording is. The grades are `inspect`, `view`, `fork`, and `retry`, ordered weakest first (§8.4). |
| **Delivery mode** | The boundary where a steer (one steering message) or a message enters a run. The modes are `next_step` (the default), `interrupt`, and `turn_boundary` (§7.3). |
| **Interrupt** | A steer that cuts the current step short instead of waiting for it to finish. It redirects a run. It does not stop one. Stopping is `pause`. |
| **Transport** | The player above a run's transcript. Its controls are scrub, step, play, pause, and speed. It moves the viewer, never the run. It has no stop control (§8.4). |
| **Data plane** | The set of data stores bound to one organization. It is shared by default. It is dedicated for customers whose firewall is the boundary (ADR-042). |

**The hierarchy, top to bottom:** organization → workspace → operator → agent → run → turn → step (model call | tool call) → frame. One operator has many agents. One agent has many runs. Every run has one operator. Oxagen attributes spend, progress, and proof to every level of this chain and to nothing else.

**Words the product does not use:** *execution* and *invocation* (say run or step). Also avoid *action event* (say step, or name the kind). Avoid *trace* as a noun for a run (say run, because a run *has* a trace). Avoid *span*, which is internal to OpenTelemetry export only. Avoid *attempt*, which is internal to the ledger (the internal record of run history). Customers see "resumed" instead. Avoid *session* except as the harness's synonym for run. Avoid *@all* as an address (say `@agents`). Avoid *render replay* and *re-run* as replay grades (say `view` and `retry`).

---

## 4. Architecture

### 4.1 Components

```
                    ┌──────────────────────────────────────────────────────┐
  agents            │  GATEWAY (stateless, horizontally scaled)            │
  ──────            │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
  Stella ──────────▶│  │ model proxy  │  │ tool gateway │  │ control ch │  │
  Claude Code ─────▶│  │ /v1/models/* │  │ MCP endpoint │  │ bundle,cmd │  │
  Agent SDK ───────▶│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
  custom ──────────▶│         │  kernel.invoke() with IAM, budget, approval │
                    └─────────┼────────────────┼───────────────┼───────────┘
                              ▼                ▼               ▼
  ┌───────────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────┐
  │ Postgres      │   │ Neo4j        │   │ Object store│   │ GitHub repo  │
  │ control ledger│   │ one db / org │   │ WORM, keyed │   │ per workspace│
  │ identity, IAM │   │ graph, runs, │   │ frame bodies│   │ published    │
  │ tools, prices │   │ frames,      │   │ archive     │   │ steering     │
  │ cost, billing │   │ records,     │   │ segments    │   │ (Context PRs)│
  │ approvals     │   │ ontology     │   │             │   │              │
  └───────────────┘   └──────────────┘   └─────────────┘   └──────────────┘
                              ▲
                    ┌─────────┴──────────────────────────────────────────┐
                    │  SERVICES: recorder, reflector, promoter, ontology  │
                    │  engine, reconciler, archiver, GitHub app           │
                    └─────────────────────────────────────────────────────┘
                    ┌────────────────────────────────────────────────────┐
                    │  MISSION CONTROL (web), API, MCP, CLI               │
                    └────────────────────────────────────────────────────┘
```

- **Gateway.** The only path from an agent to a model or a tool. It is stateless, meaning it keeps no data of its own between requests. It reads policy bundles and budgets from Postgres through a short-lived cache. It writes frames to the recorder queue.
- **Kernel.** One `invoke()` call runs the pipeline that exists today. The steps are: resolve the agent tool, validate the input, enter tenant scope (limit the call to one organization's data), make the IAM decision (IAM is identity and access management, the check of who may do what), which is always audited, admit the call against the budget, pass the approval gate, run the handler, validate the output, and write the audit record. The shape carries over unchanged. The count drops to about seventy agent tools.
- **Recorder.** Consumes batches of frames and checks that each frame chain is intact. Writes frame nodes to Neo4j and frame bodies to object storage. Prices model frames and updates run rollups (summed totals per run).
- **Reflector.** After a seal (the step that closes a run's record), it produces observation and memory records from the run.
- **Promoter.** Collects records across runs, produces proposals, opens Context PRs, and records promotion events when a Context PR merges. A Context PR is a pull request, a proposed change that reviewers approve before it merges.
- **Ontology engine.** Profiles ingested sources, proposes ontology versions, activates them, and builds entities with provenance (a record of where each fact came from). The ontology is the graph's definition of entity types and how they relate.
- **Reconciler.** Matches the cost ledger to the provider's usage exports and invoices.
- **Archiver.** Seals archive segments, compacts frame nodes older than the hot window (the recent period kept in the graph for fast queries), and enforces retention rules and holds.
- **GitHub App.** Binds repositories, creates Context PRs, runs checks, handles merges, and re-indexes after changes.
- **Engine.** `stella serve` running in its own container. The in-app agent service reaches it over HTTP (§4.4). It runs no model and no tool itself.
- **Model layer.** The one path for every model call Oxagen makes on its own behalf (the in-app agent, reflector, promoter, and ontology engine). Calls route by tier through OpenRouter (§4.5), a service that forwards model calls to many vendors. Customer agents' model calls go through the model proxy, not this layer.

### 4.2 The three stores and what belongs where

| Store | Holds | Never holds |
|---|---|---|
| **Postgres** (shared plane, or dedicated for tenant data) | Identity, tenancy, IAM, the tool registry and its schemas, the price book, the cost ledger and its rollups, reconciliation, billing, budgets, approvals, intervention commands, archive manifests, control-plane audit events, connector sync state | Graph relationships, frame bodies, traces |
| **Neo4j** (one database per organization) | Ontology versions, entities and relationships, source records, context records and their lineage, runs, attempts, frames (metadata, digests as content fingerprints, and cost), the steering index, provenance edges | Bytes larger than a few KB, money of record, credentials |
| **Object storage** (write-once, per-org key) | Frame bodies (prompts, completions, tool input and output), archive segments, exports | Anything queried directly |
| **GitHub repository** (per workspace) | Published steering records and the promotion ledger | Traces, memories, proposals |

Rule: **the graph is the system of record, and git is the system of control.** The graph is the source of truth for everything the product explains: entities, the ontology's versions and provenance, runs, frames, records, and their whole lineage. Git is the source of truth for exactly one thing: what is published and active. That means steering records, agent definitions, and the ontology's active version, each approved through a pull request. Postgres holds what must be transactional and money-grade (each change lands whole or not at all, and the amounts are exact). Object storage holds raw bytes. A rollup in Postgres (per-run cost, daily spend by agent) is a derived index. It is labeled as such and can be rebuilt from the graph.

This is not the mirror problem (two copies that drift apart), because every fact has exactly one writer:

| Fact | Written by | Read by | How the copy is kept honest |
|---|---|---|---|
| Published text of a record, an agent definition, or the active ontology | git, on merge | the graph indexes it by content hash (a short fingerprint computed from the text) at the merged commit | recompute the hash, and a mismatch is `steering_drift`, which blocks delivery |
| A record's lineage, evidence, contradictions, promotion events, and effect | the graph | Mission Control and agents | never in git |
| A proposal | the graph | delivered to git as a pull request | one direction only: graph to git |
| Publication | git | flows to the graph on merge | one direction only: git to graph |

Platform engineers call this pattern GitOps: the desired state lives in git, a controller reconciles the live system to it, and drift is detected and reported. Oxagen is the controller. Steering and definitions are the desired state. The graph and the wrapped agents are the live system.

ClickHouse is retired. Its two jobs, append-only trace rows and spend analytics, are now covered by frame nodes in the graph (for the hot window) plus Postgres rollups. The current `tacho_events` table, `token_usage`, and `tool_invocations` do not carry forward. The reason is the one already stated: one store of truth for the run record, with no mirror copy to keep in sync.

### 4.3 Language and runtime

TypeScript on Node runs the control plane (the part that sets and enforces rules), the gateway, the services, and the UI. Hono handles HTTP, Drizzle handles Postgres access, and the official Neo4j driver sits behind one graph service. The official `@contextgraphprotocol/typescript-sdk` is the source of protocol types (ADR-036). An SDK is a software development kit, a library that developers build on. Zod schemas remain the runtime validators at the trust boundary (the point where outside input enters the system). They are compile-checked against the SDK types. Rust stays in Stella and the protocol crates (Rust packages). Stella is deployed as a service, never embedded. The gateway's hot path is streaming pass-through. A Node process adds well under thirty milliseconds at the median for a proxied model call, which is the budget in §15.

### 4.4 The in-app agent and the Stella engine

The in-app agent is a turn on `stella serve`, reached over HTTP (ADR-053, carried unchanged). The engine runs as its own container next to the control plane. Oxagen opens a run, posts a turn, and reads the event stream. **The engine never calls a model and never runs a tool.** Each completion and each tool call comes back to Oxagen as a reverse request, meaning the engine asks Oxagen to do the work:

- A **tool call** is answered through `kernel.invoke()`. It passes the IAM, entitlement (what the plan allows), approval, and budget gates like every other call. It writes an audit record and bills as one governed action. The engine sees a tool result, never a credential. The in-app agent's tools are agent tool contracts only: bind a repository, register an agent, grant a tool, set a budget, query the graph, open a run, explain a frame, and open a Context PR.
- A **completion** is answered through the model layer (§4.5). The key stays in Oxagen. The engine sees only text.
- The engine holds no authority. Its only configuration is a bearer token (a secret string sent with each request to prove identity) and the tool set named `remote`. Oxagen owns all persistence. The turn's checkpoint (a saved snapshot of the turn's state) and its events are frames in a run of the in-app agent. So a turn can be replayed from Oxagen's record like any other run.
- The engine is a required service. If it is down, the in-app agent says so with a named error. Nothing falls back to an in-process loop.

The in-app agent does three things, in order of importance: **onboarding**, **configuration** (roles, grants, budgets, connectors, retention, all through the same agent tools a human would click), and **explanation** (answering questions about runs, frames, records, and spend). It has no sandbox, no file system, no browser, and no subagents. Those live in the Stella CLI on the customer's machine.

**Onboarding is gated, and it is three steps.** A new organization does not see the app. It sees one screen with three steps: (1) name the organization, (2) wrap an agent, with one click for Claude Code or Codex (the installer, §7.2) or with the five-line `oxagen.agent.wrap({})` snippet for an SDK agent, and (3) start a run. The full app unlocks the moment the first frame from that agent reaches Oxagen. The operator then lands on Fleet looking at their own run. That run is also the installer's smoke test, so there is one path, not two. The installer reads the git remote of the directory it ran in. It offers that remote as the main repo with one more click, which installs the GitHub App. The workspace is then bound without any typing. If that step is skipped, the workspace is provisional for 14 days. Runs record and spend counts, but steering, records, and agent definitions stay off until a main repo is bound, and the reason is shown. The unlock screen shows the first run's actual cost beside the onboarding discount (§12.1), once. Onboarding is not complete, and the app does not open, until an agent has talked to Oxagen.

### 4.5 Model access and routing

Every model call Oxagen makes on its own behalf goes through one model layer. That layer resolves three things, in order: the organization's **funding source**, the **tier** the caller asked for, and the **provider route** for that tier.

**Funding source** (ADR-053, carried): `platform` or `customer_key`. With the first, Oxagen pays on Oxagen's OpenRouter account. That usage is billed back as assistant usage at vendor cost plus a published markup, capped per organization. With the second, the customer's own OpenRouter or vendor key is used. That key is stored enveloped (encrypted with a key that is itself encrypted), tested before save, and never returned, and every read of it is audited. Its tokens are reported and billed at zero. A new organization starts on `platform`. Vendor neutrality is preserved: a customer key may point at OpenRouter or directly at a vendor, and the route table below is set per organization.

**Tiers and default routes:**

| Tier | Use | Default route (OpenRouter) | Resolves today to |
|---|---|---|---|
| `complex` | in-app agent turns, reflection reasoning, promotion rationale, ontology diff explanation, conflict analysis, Context PR bodies | `z-ai/glm-latest` | GLM 5.3 (1.3M context) |
| `light` | classification, labeling, entity and property naming, record kind detection, redaction hints, approval summaries, retrieval reranking | `z-ai/glm-flash-latest` | GLM 5.3 Flash |
| `embed` | embeddings (numeric vectors that capture meaning, used for search) for entities, records, documents, issues, and code (§11.5) | Voyage AI, direct API (the vendor's own programming interface, not OpenRouter): `voyage-4` family for text, `voyage-code-3` for code, `voyage-context-3` for chunked documents | one 1024-dimension space per model family |
| `rerank` | reordering hybrid retrieval candidates (§11.5) | Voyage AI `rerank-2.5` | n/a |

Rules:

1. **Configure the alias, record the concrete model.** Tiers point at OpenRouter's rolling aliases, so "latest" stays current without a deploy. Every `model.response` frame records the concrete model id the provider returned. The cost record prices that concrete id from the price book. A replay therefore names the exact model, and a reconciliation never matches on an alias.
2. **Routes are organization settings** with platform defaults. An organization may pin a concrete id, choose a different vendor per tier, or set a fallback route for when the primary returns a provider error. Every fallback is recorded as a frame.
3. **No call reads the process environment.** Keys and routes come from the model layer's resolver, the same lookup point the data-plane resolver uses. A call path that bypasses it is a defect.
4. **Batch variants** (`:batch`) queue calls to be processed together later, at their own price. They are allowed only for the reflector and promoter, which run asynchronously (outside the request path). They are recorded with their own price entries.
5. **Customer agents are unaffected.** Their model calls pass through the model proxy with their own keys and models. The tier table governs Oxagen's own work only.

---

### 4.6 Deployment modes: Oxagen's cloud, or behind the customer's firewall

Oxagen runs as a multi-tenant cloud (one deployment serving many organizations) and, from Series A, behind a customer's firewall, from the same code. Per-organization data planes (§5) already make every store switchable. So the appliance is a deployment mode, not a fork.

- **One deployment artifact.** A signed bundle stands up the gateway, the services, Mission Control, the Stella engine, the witness runner, Postgres, Neo4j Enterprise, and S3-compatible object storage with object lock. The bundle is a Helm chart (an install package) for Kubernetes (the system that runs and scales containers), with a single-node Docker Compose variant (a one-machine setup) for evaluation. Object lock is a storage setting that blocks edits and deletes for a set period. The containers are the same as the cloud's, with a deployment mode flag.
- **Connectivity is outbound only, and optional.** Nothing inbound is required. Outbound is needed only for what the customer chooses: model providers (or none), GitHub or GitHub Enterprise Server, and an optional signed usage report sent to Oxagen for metering (measuring usage). Fully air-gapped, meaning no network path to the outside, is a supported mode, not a degraded one.
- **Air-gapped means in-firewall models.** Model routes (§4.5) point at models the customer serves inside its own network: the owned models on the roadmap, or any OpenAI- or Anthropic-compatible endpoint. Embeddings default to Voyage's API in the cloud. Behind a firewall they get an in-firewall route to a self-served open-weight embedding model (one whose weights are published for anyone to run). One model per index (§11.5) makes that a per-deployment choice, never a mixed state.
- **Everything the cloud enforces, the appliance enforces.** That includes the witness runner and the assurance suite, which the customer runs against its own deployment and hands to its auditor.
- **Updates are signed bundles** that the customer applies on its own schedule. The migration runners already iterate per plane. Licensing is per organization, annual, and invoiced. Stripe is not involved behind a firewall. The two cloud-only assumptions in this document (Stripe, OpenRouter) are deployment-mode settings.

## 5. Tenancy and isolation

### 5.1 The model

The model is exactly today's model. An **organization** holds **workspaces**. A person belongs to an organization with one org role. The same person belongs to workspaces with one workspace role each. Agents belong to a workspace. Only the table count and the enforcement change.

**Organization.** Its `public_id` starts with `org_`. It has a `slug` and an immutable `namespace` of 2 to 6 characters. Immutable means the value is fixed at creation and never changes. The `namespace` is used in agent keys and in the Neo4j database name. The organization also has a `plan`, a `status`, and settings. It owns: a KMS key-encryption key, the Neo4j database `org_<namespace>`, a billing account, an optional dedicated data plane (ADR-042), and its retention policy. KMS is a key management service, a cloud service that stores and guards encryption keys. A key-encryption key is a top-level key that encrypts other keys rather than data.

**Workspace.** Its `public_id` starts with `wrk_`. Its `slug` and immutable `namespace` are unique within the org. It owns: one **main repo** (required at creation, §10.1) plus any number of linked repos, one active ontology version, one steering set, agents, tool grants, budgets, a governance mode (`solo` | `team` | `regulated`), and a retention mode (`content_exact` by default, `digest_only` as an opt-down).

**Roles.** Org roles are `owner`, `admin`, `member`, `billing`, `compliance`, and `viewer`. Workspace roles are `owner`, `member`, and `viewer`. Agent roles are `observer`, `contributor`, and `operator`. Custom roles are an enterprise feature. They are built from the same grant table, not from a second system.

### 5.2 Postgres: Row-Level Security without a bypass switch

Row-Level Security (RLS) is a Postgres feature. It attaches a rule to a table, and the database hides any row the rule rejects. Every tenant table carries `org_id NOT NULL`. Workspace tables also carry `workspace_id NOT NULL`. There are two policy classes, down from six today:

- `org`: rows belong to the organization (memberships, invitations, billing, roles, price overrides, archive manifests).
- `workspace`: rows belong to one workspace (agents, tool grants, budgets, approvals, commands, connector state).

The application sets scope once per transaction with transaction-local settings, exactly as `withTenantDb` does today. A transaction-local setting, also called a GUC in Postgres, is a named value that lives only for the current transaction. The policy reads those settings. Nothing else can widen the scope.

```sql
-- helper functions, STABLE, run as the invoker
create function app.current_org() returns uuid language sql stable as
  $$ select nullif(current_setting('app.current_org_id', true), '')::uuid $$;
create function app.current_workspace() returns uuid language sql stable as
  $$ select nullif(current_setting('app.current_workspace_id', true), '')::uuid $$;

-- class: workspace
alter table wrk.agents enable row level security;
alter table wrk.agents force row level security;
create policy tenant_isolation on wrk.agents
  for all to oxagen_app
  using (org_id = app.current_org()
         and (app.current_workspace() is null or workspace_id = app.current_workspace()))
  with check (org_id = app.current_org() and workspace_id = app.current_workspace());

-- system access is a role, not a setting
create policy system_access on wrk.agents
  for all to oxagen_system using (true) with check (true);
```

Rules:

1. **No `app.rls_bypass`.** Today any logged-in role can set it, and every policy honors it. This design deletes that setting. System paths connect as `oxagen_system` instead. These paths include identity resolution before scope exists, webhooks, cron, and bootstrap. `oxagen_system` is a distinct role with its own policy, its own connection pool, and its own audit counter. `oxagen_app` is not a member of `oxagen_system` and cannot `SET ROLE` to it.
2. **Org-level sessions see all workspaces of their org.** When no workspace is set, the read predicate collapses to `org_id`. Writes to workspace-class tables always require a workspace. This replaces today's nullable-workspace tables.
3. **Startup guards stay.** The app refuses to boot in production if the app role is a superuser or has `BYPASSRLS`. A superuser is a Postgres account that skips every permission check. `BYPASSRLS` is a role attribute that lets a role skip RLS rules. The app also refuses to boot if RLS enforcement is off.
4. **The policy manifest is generated from the schema.** A CI test checks that every `org_id` column appears in it. This rule carries over from today.
5. **Dedicated data planes.** A dedicated Postgres data plane holds tenant data only. Identity, IAM, billing, and the price book stay on the shared data plane (ADR-042). The resolver is the only place that reads a connection string.

### 5.3 Neo4j: one database per organization

Property-based access control is a Neo4j feature that grants or denies access based on a property value on each node. In Neo4j it is read-only, it takes literal values only, and it costs query performance. It cannot be the write-side boundary, so it is not the tenant boundary.

The tenant boundary is the database. Each organization gets `org_<namespace>` at creation. Aura Business Critical and Virtual Dedicated Cloud support multiple databases per instance at the same GB-hour price. Self-managed Enterprise does the same. A query cannot cross databases without a composite database, and Oxagen never creates one. That is the graph equivalent of RLS. The engine enforces isolation, with no `WHERE org_id` clause anywhere.

Inside an organization:

- **Every node and relationship carries `ws` (workspace public id)** as a required property. The graph service sets it, and the graph service is the only writer. The graph service rejects a write that omits it before Cypher runs. Cypher is Neo4j's query language. Indexes exist on `(ws)` for every label.
- **The graph service issues reads under the caller's scope.** Workspace-scoped sessions inject `$ws`. They refuse Cypher that does not bind it. The regex guard exists today and stays as defense in depth, a second check behind the first. Org-scoped sessions may read across workspaces.
- **Enterprise option:** per-workspace Neo4j users with property-based READ privileges (`WHERE n.ws = '<id>'`) for human graph-explorer sessions. These sessions run through impersonation from one application connection. Impersonation means the one application connection acts as the per-workspace user for that session. This option is off by default because of the performance cost. It is on for customers who require an engine-enforced workspace boundary for reads.
- **Platform catalogs are not in the graph.** Price books, tool schemas, and connector definitions live in Postgres. The graph holds tenant knowledge only. So a per-org database never contains another tenant's data, by construction.

**The limits, verified against Neo4j's documentation (2026-09-11).** The following limits apply to Aura Business Critical and Virtual Dedicated Cloud. Multiple databases must be enabled when the instance is created, and the setting cannot be changed later. The cap is 5 databases per GB of RAM, with a hard ceiling of 100 per instance (2 GB: 10, 4 GB: 20, 8 GB: 40, 16 GB: 80, 32 GB and above: 100). All databases share the instance's compute and memory. Databases are created only through the Aura API or console, never with Cypher. A default `neo4j` database always exists. Billing is the standard GB-hour rate regardless of count. Neo4j still lists the feature as public preview. Public preview means Neo4j offers the feature to customers before it is generally available. On self-managed Enterprise the cap is the `dbms.max_databases` setting. Its minimum is 2, and it is configurable. The current default was not confirmed from the documentation and is not assumed here.

Operational rules that follow:

1. **Every Aura instance is created with multiple databases enabled**, since it cannot be turned on later. Organization creation calls the Aura API to create the database. The self-managed path uses Cypher. Both sit behind one provisioning interface.
2. **Sharding rule.** Sharding means splitting organizations across several instances. The vendor's ceiling allows at most 100 organizations per instance. The operational target is 25 paid organizations per 32 GB instance, so tenants are not starved of page cache. Page cache is the memory Neo4j uses to hold graph data for fast reads. The target is revisited from memory metrics. The `neo4j_instance_id` column on organizations carries the mapping. Adding instances is therefore an operations task, not a code change.
3. **Free and trial organizations do not consume a database.** With a ceiling of 100, provisioning on signup would burn the cap on empty tenants. Free organizations run in a pooled database with the same workspace property scoping and the same graph service. They move to their own database on the first paid plan. The move is an export and import of one organization's subgraph, and the archiver runs it.
4. Database creation is part of organization creation and is safe to repeat. Deletion is a soft state (`suspended`), followed by export and drop after the retention window.
5. **Preview status is a named risk** (§18). Self-managed Enterprise on Kubernetes is the fallback if Aura's feature slips or its limits change before customer 1. The data plane table can point an organization at either.

### 5.4 Keys

Each organization has one key-encryption key in KMS. Data-encryption keys are the keys that encrypt the data itself, and the key-encryption key encrypts them. There is one data-encryption key per object (frame bodies, archive segments). Where erasure requires it, there is also one per subject (§13.5). The existing envelope-encryption package carries over.

---
## 6. Identity, access, and the toolbelt

### 6.1 Principals

`iam.principals` (IAM means identity and access management) holds `kind ∈ {human, agent, service}`, `org_id`, `workspace_id` (required for agents), `parent_user_id` for an agent that acts on behalf of a person, and `status`. A human principal is bound to `auth.users`. Better Auth carries over. A service principal is a machine identity. Oxagen's own services and customer integrations use it.

### 6.2 Agent identity and credentials

An agent is registered once, in a workspace, with:

- `agent_key`: `org_ns.ws_ns.slug`. It never changes (ADR-024).
- `harness`: `stella` | `claude-code` | `claude-agent-sdk` | `custom`.
- `principal_id`.
- A **long-lived agent credential**. This is an API key issued to the operator once. It is stored as a hash (a one-way fingerprint of the key), locked to one purpose, and revocable.
- **Short-lived run tokens** minted by the gateway at run start. The default life is fifteen minutes, refreshed on the control channel. Every model-proxy and tool-gateway call carries a run token. Revoking the agent credential or suspending the agent invalidates every run token at the next call. This is what makes a halt stick (§7.4).
- For hook-enrolled hosts (Claude Code), the host device key (Ed25519) from the agent enrollment. It signs checkpoints.

Delegation ceiling: an agent can never do more than the person it acts for. Its effective permission is its own grants intersected with the invoking human's grants. Subagents can only narrow. This carries over from the agent-RBAC spec (RBAC is role-based access control, permissions granted by role).

**Identity in Postgres, definition in git.** An agent has two halves. Its **identity** lives in Postgres: principal, credentials, roles, mandates, the things that must be revocable in one second. Its **definition** is a file in the workspace's main repo under `.oxagen/agents/<slug>.toml`. That file says what the agent is for, its instructions, which tools it may use, which model tier, and harness-specific settings. It is the source of truth for the definition. Two things join the halves. The first is the agent key (`org_ns.ws_ns.slug`, where `slug` is the file name). The second is `definition_digest`, the digest (a fixed-length fingerprint) of the file at the commit the agent last ran from. Runs record that digest as the agent's version.

```toml
# .oxagen/agents/release-manager.toml
schema = "agent-definition/v0.1"
slug = "release-manager"
name = "Release manager"
description = "Prepares release notes and opens the release PR. Never merges."
model_tier = "complex"                     # or a pinned model id
tools = ["github__*", "linear__get_issue", "search_graph", "recall_context"]
deny_tools = ["github__merge_pull_request@*", "github__delete_*@*"]
side_effects = ["read", "write"]           # never "irreversible"
budget = { per_run_micros = 2000000 }
[instructions]
body = """
You prepare releases for this repository. Read the changelog conventions in
.oxagen/rules before writing notes. Open a pull request; a person merges it.
"""
[harness.claude-code]
color = "blue"
[harness.codex-cli]
sandbox = "read-only"
```

**One source, every harness.** Each coding harness keeps agent definitions in its own place and format. Claude Code reads `.claude/agents/<name>.md` (front matter plus instructions). Codex CLI reads its own agent files. Stella reads the canonical format (the single official form). Oxagen generates the harness files from the canonical one, in the same pull request. So the repo carries `.oxagen/agents/release-manager.toml` and beside it `.claude/agents/release-manager.md` and the Codex equivalent. Each generated file has a header naming the source file and its digest, and is marked generated. The set of formats is an adapter table in Oxagen. A harness changing its format is a table change, not a product change. Stella needs no generated file: `.stella/agents` is a symlink to `.oxagen/agents` (§10.2). A pull request that edits a generated file without regenerating it fails the checks. The canonical file is the only one a person or agent edits.

**The loop the operator sees.** Creating or changing an agent in Mission Control (`register_agent`, `update_agent`) does not write Postgres first. It opens a Context PR on the main repo. That PR adds or changes the canonical file and the generated files. The checks validate the definition: the schema, tools that exist in the registry, no `irreversible` without a mandate, and instructions that pass the secret and PII scan. Merge creates or updates the principal, the roles the definition asks for, and the toolbelt. The next time the operator opens their coding agent in that repo, the agent is there. The same works in reverse. An agent definition committed by hand appears in Mission Control on merge. Its identity is created, and its status is `unenrolled` until credentials are issued. Deleting an agent is a PR that removes the file. The principal is retired, never deleted, so its runs keep their identity.

### 6.3 Roles and grants

One grant table: `iam.role_grants(role_id, subject_kind, subject, effect, resource_scope)`.

- `subject_kind ∈ {agent tool, tool}`. An agent tool subject is a kernel agent tool name (verb-first snake case, ADR-025). A tool subject is a tool pattern `server:tool@version` with globs.
- `effect ∈ {allow, deny, require_approval}`. Deny wins. `require_approval` routes to a human (§7.5).
- `resource_scope` is a typed JSON ceiling. It names the graph labels and relationship types the agent may read or extend, a traversal budget, repositories, the side-effect classes allowed (`read`, `write`, `irreversible`), the egress classes allowed, and spend limits per run and per day.

The resolver keeps the three live rules of today's resolver: role grant, org-owner override, and the agent tool's declared default. The dead condition language is not carried.

### 6.4 Tools: RBAC to the tool version, schemas on both sides

The **tool registry** (`tools.tools`, `tools.tool_versions`, `tools.tool_servers`) is the only source of tools an agent can see. A tool version has:

```json
{
  "tool_id": "tool_…", "server": "github", "name": "create_pull_request", "version": "3",
  "input_schema":  { "$schema": "https://json-schema.org/draft/2020-12/schema", "...": "..." },
  "output_schema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "...": "..." },
  "schema_digest": "sha256:…",
  "risk": "high", "side_effect": "irreversible", "egress": "third_party",
  "price": { "unit": "call", "micros": 0 },
  "consequence_tags": ["moves_money"],
  "measures": { "amount": { "path": "$.amount", "type": "money", "currency_path": "$.currency" }, "counterparty": { "path": "$.recipient", "type": "identifier" } },
  "data_classes": ["payments"],
  "idempotency": { "supported": true, "key_path": "$.idempotency_key" },
  "credential": { "connection_kind": "oauth" | "api_key" | "cloud_role" | "github_app" | "none", "downscope": "token_exchange" | "session_policy" | "restricted_key" | "none" },
  "source": "mcp" | "agent tool" | "http" | "harness",
  "schema_origin": "declared" | "imported" | "observed_approved"
}
```

Tool sources:

- **MCP servers** (MCP is the Model Context Protocol, a standard way for agents to reach tools). Schemas are imported from `tools/list`. Output schemas come from the server's `outputSchema` when declared. When absent, the gateway records observed outputs, infers a schema, and files it as a registry proposal for an admin to approve. Until approval, the output is validated only for size and type, and the run's completeness record says so.
- **Oxagen agent tools.** Input and output are the contract's Zod schemas, exported as JSON Schema (a standard format for describing the shape of JSON data).
- **HTTP tools.** An admin declares them with both schemas.
- **Harness-native tools** (Claude Code's `Bash`, `Write`, `Edit`, and so on). Schemas are known per harness version and validated at the hook payload.

The registry is the catalog. The rest of this section covers what an agent can do with it.

### 6.5 The threat model at the tool call

An agent does its damage at the tool call: the payment it sends, the record it deletes, the data it exports, the message it posts, the branch it force-pushes. Everything above the tool call is words. Oxagen is built so that the following cannot happen to a wrapped agent. Each line names what makes it impossible rather than unlikely:

| Threat | What prevents it |
|---|---|
| The agent calls a tool it was never granted | It cannot see the tool. The toolbelt (§6.6) is built from grants. A call by name to anything outside it is rejected before lookup and recorded as `unknown_tool` |
| The agent uses a credential it holds | It holds none. Credentials live in the broker (§6.8). The agent receives results, never secrets. A leaked run token cannot reach a tool server directly |
| A prompt injection in a document, page, or tool output steers the agent into a harmful call | Tool output is data, wrapped with provenance. Arguments derived from untrusted output are marked as tainted (flagged as coming from untrusted content). Taint on a write, or on a call carrying a consequence tag, raises the decision to approval (§6.7) |
| The agent takes a consequential action beyond its authority: moves money, drops a table, emails customers, deploys to production, changes who has access | Any call carrying a consequence tag requires a **mandate** (§6.9) with limits over the tool's declared measures. Before dispatch, the policy engine compares the call's measures, targets, and period against the mandate's remaining authority. The customer's approval rules decide whether a human must look |
| A retry or a loop double-charges or double-posts | Every call carries an idempotency key (a key that makes a repeated call count only once), derived from its canonical digest. The gateway suppresses a duplicate dispatch within the tool's idempotency window and records it |
| An approval is reused, forged, or applied to a different call | Approval tokens are single-use. Each is bound to the exact call digest, agent, run, and expiry, and verified against the mint key. A mismatch is `token_denied` |
| A human's broad credential is borrowed by an agent (confused deputy) | The delegation ceiling: an agent's effective grants are its own ∩ the operator's. The broker mints a credential scoped to the call, never the operator's session |
| The agent forges or omits its own audit record | The gateway writes the record, not the agent, and chains it into the run. A client-attested call is labeled as such and can never be shown as gateway-enforced |
| An operator cannot answer "who allowed this, under what authority, and what happened" | Every call has a **receipt** (§6.10): decision, policy version, grants and mandate used, approver, credential grant, request and response digests, external effect ids, all signed |
| A tool, server, agent, or workspace needs to be stopped now | Kill switches at every level (§6.11), enforced at the next call boundary by the deny generation, with token revocation behind them |

The enforcement tier (§7.1) states how much of this was in fact enforced, reported as it is, with its source. These guarantees hold at `gateway` tier. At `harness` tier the hook enforces the decision, but Oxagen did not carry the credential. At `observe` tier nothing is enforced. The record says which, on every call, and no report can say more.

### 6.6 The toolbelt and how a model sees it

An agent's **toolbelt** is the built set of tool versions it may call: `grants ∩ delegation ceiling ∩ policy bundle ∩ kill switches`. It is computed at run start, cached with the bundle version, and recomputed on any deny-generation bump. It is the only tool list the model is ever shown.

**Presentation.** Tools are presented to the model in the tool-definition format the harness expects (MCP `tools/list` for MCP clients, native tool definitions through the model proxy). Oxagen adds three properties to every definition's description in a fixed, machine-readable trailer: the risk grade, whether the call will require approval, and any budget or mandate ceiling that applies. A model that knows a call will be held for approval plans differently than one that does not. Names are stable (`server__tool`). Schemas are the registry's. Every definition carries its schema digest, so a run's frames can prove exactly which schema the model saw.

**Two modes, chosen by belt size.**

- **Full belt** (small belts, up to a workspace-set limit that defaults to 40 tools or 12k tokens of definitions): every definition is in the request.
- **Searchable belt** (everything larger): the request carries only two meta-tools plus any tools pinned as always-present. `search_tools(query, kinds?)` returns names and one-line descriptions ranked by relevance, from an index over the belt only. `load_tools(names[])` returns full definitions. Both are themselves governed calls recorded as frames, so the record shows what the model looked for and what it was shown. A search never returns a tool outside the belt. What the model cannot call, it cannot find, so it cannot be prompt-injected into calling it.

The tool-definition token count is measured on every model call (§12.6). The findings job flags belts that are wider than the agent uses.

**Harness-native tools** (a coding harness's shell, file edit, browser) are in the belt as tool versions of the harness's tool set. They are governed at the hook (harness tier), with the same grants, risk grades, and approval rules. A wrapped agent therefore has one belt across the MCP tools it reaches through the gateway and the native tools its harness provides.

### 6.7 The call pipeline

The **tool gateway** is one MCP endpoint per workspace. Every call passes these steps in this order. Each step either advances or ends the call. Each step writes what it decided into the call's frames.

1. **Authenticate.** The run token identifies agent, run, attempt, operator, and bundle version. Expired, revoked, or mismatched tokens end the call as `unauthenticated`.
2. **Resolve.** `server__tool` resolves to one tool version in the belt. Not in the belt: `unknown_tool`, recorded, and counted toward an automatic halt threshold.
3. **Validate input.** Strict validation against `input_schema` (no additional properties, formats enforced, size caps). Failure is `schema_violation`, denied. The canonical input digest is computed here. It is the call's identity for idempotency, approval binding, and receipts.
4. **Taint.** Each argument is checked against the digests of untrusted content the run has seen (tool outputs, retrieved documents, web content, context frames marked untrusted). An argument that contains or derives from such content marks the call `tainted`, with the source frame ids.
5. **Decide.** The policy engine (§6.12) evaluates grants, resource scope, the tool's safety classification, taint, the customer's approval rules and their auto-approval conditions, mandate authority for calls carrying a consequence tag, budgets, rate limits, sequence rules, and kill switches. It returns one of exactly three outcomes with the rules that produced it: **allow**, **approve** (route to a human), **deny**. The decision is deterministic (the same input always gives the same answer), versioned, and replayable. No model participates.
6. **Approve** (when the decision is approve). The call is parked with a timeout. An approval request carries the four-hop chain (operator, agent, call, rule) and the mandate if any. A human resolution mints a single-use approval token bound to the call digest. Expiry or denial ends the call with the human's reason attached, and the reason is what the model reads.
7. **Broker a credential** (§6.8). The broker mints or selects the narrowest credential the tool server needs for this call. It is scoped by the tool's declared scope and the call's arguments where the provider supports it, with a short TTL (time to live, how long it stays valid), bound to the call id. The agent never sees it.
8. **Dispatch** with an idempotency key. Duplicates inside the tool's window return the recorded result and record `duplicate_suppressed`.
9. **Validate output** against `output_schema`. Run redaction detectors when the tool's egress class or the workspace policy requires. Then wrap the result with provenance (tool version, server, response digest, external ids extracted by the tool's declared paths). Output violations are recorded. By policy, they are passed with a warning frame or replaced with a typed error.
10. **Receipt** (§6.10). Written, signed, chained. The result goes to the agent only after the receipt is durable.

Latency budget for steps 1 through 5 and 9 through 10 combined: 20 ms at p99 for schemas under 64 KB (§15). Approval and brokerage are outside the budget by nature. The model sees them as waits with reasons.

### 6.8 The credential broker

**A wrapped agent holds no credentials. Not an API key, not an OAuth token, not a cloud role, not a GitHub token.** (OAuth is the standard for letting one service act on a user's behalf.) It holds one run token that is good for talking to Oxagen and nothing else. Most of the threat model rests on this single property. It is what makes a Fortune 500 tool estate governable: every secret stays in one place, under one audit log.

**Connections** are the customer's credentials to tool servers and APIs, stored in the vault (enveloped under the organization's key, every read audited). They include OAuth grants with refresh tokens, API keys, cloud roles Oxagen may assume, and GitHub App installations. A connection is bound to a workspace and to the tool servers it authorizes. It has an owner (a human) and a review date.

**Per-call credentials.** For each dispatched call the broker produces the narrowest credential the provider allows, in this preference order:

| Provider support | What the broker mints | Examples |
|---|---|---|
| Token exchange (trading one token for a narrower one) or downscoping | a short-lived token scoped to the call's resource and action | OAuth 2.0 token exchange (RFC 8693), Google downscoped tokens, Microsoft on-behalf-of with narrowed scopes |
| Session policies (temporary rules attached to one login session) | a temporary session whose policy is the intersection of the connection and the call | AWS STS `AssumeRole` with a session policy naming the bucket or table in the arguments |
| Restricted or installation tokens (a restricted key is limited to set actions and targets) | a key limited to the tool's agent tools and the call's targets | Stripe restricted keys, GitHub App installation tokens limited to the repositories in the call |
| None | the stored credential, used server-side by the gateway for this call only, never transmitted to the agent | legacy API keys |

Each mint is a **credential grant**: connection id, scope, TTL, call id, and the provider's token identifier where one exists, recorded on the call's receipt. TTL defaults to the call's expected duration plus a margin, never more than one hour. Revoking a connection invalidates its grants at the next use.

**Connections behind consequential tools.** A connection is marked `requires_mandate` when any tool it backs carries a consequence tag: payment processors, banking, cloud billing, production databases, deployment systems, customer messaging, identity providers. Such a connection requires a named human owner with a role the workspace names for that consequence. It requires a mandate (§6.9) for every agent that may use it. It requires a restricted or downscoped credential where the provider offers one, and the gateway refuses to expose a full-scope key to such a tool. It also offers a two-person rule option (two people must approve) on connection creation and on mandate changes.

### 6.9 Safety classification, approval rules, auto-approval, and mandates

Three things that are easy to confuse are kept apart, in the code and in the interface. Nothing in the product is named after money. Money is one example of a consequence.

**1. Safety classification describes a tool and decides nothing.** Every tool version carries the following. A risk grade. A side-effect class (`read`, `write`, `irreversible`). An egress class. **Consequence tags**, from a starter set the customer extends (`moves_money`, `destroys_data`, `alters_production`, `communicates_externally`, `changes_access`, `changes_entitlement`, and any tag the customer defines). **Measures** the tool exposes, declared as paths into its input with a type and a unit (an amount with a currency path, rows affected, a target environment, a recipient count, a table name). And the data classes it touches, from the data layer (§11.7). Classification is set when a tool is imported or declared, reviewed on the Tools page, and shown to the model in the tool definition. It never allows or denies anything by itself.

**2. Approval rules decide, and they belong to the customer.** An approval rule is policy (§6.12) over any tool, written against the classification and the call: tool pattern, consequence tags, measures, data classes, taint, time window, sequence, environment, operator role, agent, mandate position. Its outcome is allow, approve (a human must look), or deny. **Auto-approval** is an approval rule whose conditions, when met, let Oxagen skip the human. Those conditions can be a measure under a threshold, a counterparty or environment on an allow list, a call inside a mandate's remaining authority, a standing approval (the same call digest approved by a person within a window the rule names), no taint, or business hours. An auto-approved call is recorded as an approval whose approver is `policy:<rule id>`. So the receipt says plainly that no person looked. The assurance suite includes a case that an auto-approval never fires outside its conditions.

**3. A mandate is bounded, expiring authority for a consequence.** A human with the role the workspace names for a consequence tag grants one agent authority to cause that consequence, within limits over the tool's declared measures. Nothing in a grant, a role, or a bundle substitutes for it. A call carrying a consequence tag with no mandate is denied before dispatch. One that exceeds its mandate is denied or routed to a human by the mandate's own approval rule.

```json
{
  "mandate_id": "mnd_…", "agent": "a-intel.finops.invoice-bot", "granted_by": "usr_…", "role_at_grant": "org.billing",
  "consequence_tags": ["moves_money"],
  "limits": {
    "amount": { "per_call": 250000000, "per_period": 2000000000, "currency": "USD", "period": "monthly" },
    "calls":  { "per_day": 50 }
  },
  "targets": { "counterparty": { "allow": ["vendor:aws", "vendor:github"], "deny": ["*"] } },
  "tools": ["stripe__create_payment@*", "aws_billing__purchase_savings_plan@2"],
  "approval": { "human_above": { "amount": 100000000 }, "always_human_for": ["destroys_data"], "approvers": ["role:org.billing"] },
  "purpose": "monthly infrastructure invoices, PO-4471",
  "valid_from": "2026-09-01T00:00:00Z", "valid_to": "2026-12-31T23:59:59Z",
  "two_person": true, "second_approver": "usr_…",
  "status": "active"
}
```

The same shape covers the other consequences. Destroying data: measures `rows_affected` and `tables`, targets limited to named environments, `per_period` on rows, always human for production. External communication: measure `recipients`, `per_day`, targets limited to domains. Production changes: measure `target_environment`, `per_day`, a time window. Access changes: measure `principals_affected`, targets limited to roles below the granter's own.

Rules:

- **Measures are read from the call**, by the tool version's declared paths. A tool that carries a consequence tag but exposes no measure for the limit a mandate names cannot be granted that mandate. It is denied by construction.
- **Remaining authority is tracked in Postgres** as a ledger by measure (`tools.mandate_ledger`: reservations at decision time, settlements at receipt time, releases on failure). So two concurrent calls cannot both fit under the same remaining limit.
- **Every consequential receipt records the external effect id** (a transaction id, a migration id, a message id, a deployment id) and the mandate it drew on. Where a connection reports its own activity (a payment processor's statement, a database's audit log, a deployment system's history), the reconciler matches settlements to it. Any external effect attributable to the connection with no receipt is an exception at severity critical: an action Oxagen did not govern.
- **Mandates expire.** They are reviewed on a schedule the organization sets. Every change is a two-person action when the mandate says so. Revoking a mandate ends in-flight calls that have not dispatched.
- Mandates are visible on the Tools page as a ledger the accountable office can read (finance for money, the platform team for production, security for access). It shows who granted what authority to which agent, how much is used, and what it was for.

### 6.10 Receipts: provenance for every call

A **receipt** is the signed record of one tool call. The gateway assembles it from the call's frames at step 10 and stores it as its own frame. It is what an auditor, a security lead, or a CFO opens.

| Field group | Contents |
|---|---|
| Who | operator, agent, run, turn, step, and the task reference if any |
| What | tool version, schema digest, canonical input digest, and the input (or its redacted form per retention policy) |
| Authority | decision outcome, policy version, rule ids that fired, grants used, delegation ceiling result, mandate id and amount reserved, approval token id and approver with reason, taint sources |
| Credential | credential grant id, connection id, scope, TTL, provider token identifier |
| Effect | dispatch time, tool server, response digest, output validation result, redactions, external effect ids (payment id, PR number, message id, object key), idempotency key and whether a duplicate was suppressed |
| Integrity | frame hash, chain position, gateway signature, enforcement tier |

Receipts can be exported one at a time or in bulk (CSV, JSON, signed bundle). They are the unit the Audit page searches. A receipt for a client-attested call exists too. Its authority group says `observed` where the gateway would have said `enforced`.

### 6.11 Kill switches and blast radius

Deny is available at every level. It takes effect at the next call boundary through the deny generation, with token revocation behind it for anything that keeps calling:

- a **tool version** (a server shipped a bad version), a **tool server**, a **connection** (a credential is suspected leaked, and its grants die with it),
- an **agent**, an **operator's agents**, a **workspace**, an **organization**,
- a **class**: every tool carrying a consequence tag (`moves_money`, `destroys_data`, `alters_production`, or a customer tag), every `irreversible` tool, every tool with `egress: third_party`, across the organization, in one action.

Automatic triggers issue the same denies: repeated `unknown_tool` attempts, taint on a call carrying a consequence tag, a mandate exception, a credential probe, a chain break. Every switch flip is a security event with who, why, and what it stopped. Every flip shows up on the affected runs as `policy.decision` frames.

### 6.12 Policy: deterministic, versioned, simulated

Tool policy is written in **Cedar**, an open policy language (the decision the wrapper design already reserved). It is compiled from three inputs: role grants and resource scopes (§6.3), mandates (§6.9), and workspace rules authored on the Tools page or as records in the main repo. Policy is:

- **Deterministic.** Same call, same policy version, same answer. No model in the decision path, ever.
- **Versioned and signed.** Every decision cites the policy version. Every bundle carries it. A policy change is a governed action with approval and, in regulated mode, a Context PR.
- **Testable.** Policies ship with test cases (this call must be denied, this one must require approval) that run on every change.
- **Simulated.** Before a policy version is activated, Oxagen replays it against the workspace's last N days of tool calls from the frames. It reports what would have changed: calls that would now be denied, calls that would now need approval, and calls the new version would allow that the old version denied. A CIO sees the effect of a control before it is switched on, on their own agents' real history.

Policy can use these conditions. All come from the call and the record, none from prose: tool version and its safety classification (risk, side effect, egress, consequence tags, measures, data classes), argument values by path (amount, counterparty, repository, path prefix, recipient domain), taint and its sources, time window, rate and sequence (a payment requires a prior quote call in the same run, and a delete requires a prior read of the same object), operator role, enforcement tier, and budget and mandate position.

### 6.13 Assurance

Guarantees a customer cannot test are claims. Oxagen ships an **adversarial tool-governance suite**. It runs against a live gateway in CI and against a customer's own deployment on demand. Each case tries to break one guarantee and must be caught:

| Case | Expected |
|---|---|
| Call a tool outside the belt by name | `unknown_tool`, no dispatch, halt threshold incremented |
| Search for a tool outside the belt | zero results |
| Reuse an approval token on a second call, or on a modified call | `token_denied` |
| Present a run token to a tool server directly | rejected, because tool servers accept only broker credentials |
| Call a tool carrying a consequence tag with no mandate, with a measure over the mandate, or with a target outside it | denied before dispatch, mandate ledger unchanged |
| Retry a dispatched consequential call | `duplicate_suppressed`, one external effect |
| Trigger an auto-approval rule with one condition unmet (tainted input, off hours, over threshold) | routed to a human, never auto-approved. The receipt names the unmet condition |
| Pass an argument copied from a tool output into a write call | `tainted`, raised to approval |
| Flip a kill switch during a run | next call denied, frame shows the switch and the reason |
| Modify a receipt after the fact | chain verification fails |
| Report a client-attested call as gateway-enforced | rendering refuses, because the tier is read from the record |

Results are published per release with the suite's version. The suite is part of the export a customer's auditor receives. The suite's own results are reported as they are, with their source: a case that cannot run at a customer's enforcement tier is reported as not applicable, never as passed.

---

## 7. The gateway and intervention

### 7.1 The three seams

| Seam | What passes through | What Oxagen can do | Tier it earns |
|---|---|---|---|
| **Model proxy** | Every model request and response, streamed | Inject steering and context frames, price the call, enforce budgets, park the call for approval, halt the run by returning a stop, record full bodies | `gateway` |
| **Tool gateway** | Every tool call and result | Check both directions, allow or deny or send for approval, narrow the input, record | `gateway` |
| **Hook and SDK adapter** (the wrapper). A hook is a script the harness runs at set points in its lifecycle. An SDK is a code library an agent is built on. | Harness lifecycle events: session start, prompt submit, pre-tool, permission request, stop, compaction, config change | Deny at boundaries, inject context, request elevation, detect tampering | `harness` |
| None of the above | Attested events only | Record and grade | `observe` |

A wrapped agent is one that routes through at least one gateway connection point, the point where the agent connects to Oxagen. Routing the model proxy is the strongest single control. It sees every token and can stop the loop at its source. Claude Code and Codex CLI both reach the proxy through their base URL setting, the address a harness sends its model requests to. The enrollment writes that setting. So a hook-enrolled host earns `gateway` on model calls whatever the model vendor. Tools reach the gateway through the Oxagen MCP endpoint. MCP is the Model Context Protocol, the standard way agents call tools. Harness-native tools remain `harness` tier.

The **enforcement tier is computed per run from what was actually observed**. It is recorded on the run and shown word for word. The UI, exports, and attestation reports cannot show a stronger word than the tier allows. This is the rule from ADR-040 and the wrapper spec that the tier is reported as it is, with its source. It is kept as a rule that must not change.

### 7.2 Adapters and supported agents

Oxagen is vendor-neutral on the agent side as well as the model side. The model proxy speaks the **Anthropic Messages API**, the **OpenAI Chat Completions and Responses APIs**, and the OpenAI-compatible dialect most other vendors and gateways expose. So any harness that uses a base URL setting can be routed through it. The tool gateway is plain MCP, which every current harness speaks.

| Agent | How it is wrapped | Model calls | Tools | Tier |
|---|---|---|---|---|
| **Stella** | native: control contract over `stella serve` (`/pause`, `/resume`, `/cancel`, `/steer`), journal drained to the recorder | proxy | gateway | `gateway` |
| **Claude Code** | agent enrollment: device key, `oxagend` collector, hooks in user or managed settings (command hooks fail closed), OpenTelemetry export (a standard format for activity data) to the collector, `ANTHROPIC_BASE_URL` at the proxy | proxy | MCP tools via gateway. Native tools at the hook | `gateway` for model and MCP tools, `harness` for native tools |
| **Codex CLI** (OpenAI) | agent enrollment writes `~/.codex/config.toml`: MCP servers pointed at the gateway, `OPENAI_BASE_URL` at the proxy, the notify hook to the collector, and the approval policy set to route through Oxagen. The managed variant pins the config | proxy | MCP tools via gateway. Native shell and file tools are observed through the proxy's tool call frames and enforced by approval policy where the harness exposes it | `gateway` for model and MCP tools, `harness` or `observe` for native tools by harness version |
| **OpenAI Agents SDK** (Python, TypeScript) | `oxagen.agent.wrap(agent)` installs the proxy base URL, a tracing processor that emits frames, input and output guardrails that call the checkpoint gate, and the MCP endpoint as the agent's tool server | proxy | gateway | `gateway` |
| **Claude Agent SDK** | `oxagen.agent.wrap(agent)` with the SDK's hooks and the proxy base URL | proxy | gateway | `gateway` |
| **Custom agents** (any language) | the SDK wrapper in TypeScript, Python, or Go, or the raw contract: run token, proxy base URL, MCP endpoint, checkpoint gate before each turn, frame emitter | proxy | gateway | depends on what the wrapper could route, computed per run |
| **Other CLIs** (Gemini CLI and similar) | enrollment writes their MCP and base URL settings where they exist. Otherwise, observe-only ingestion of their telemetry | proxy where supported | gateway where supported | as observed |

The **checkpoint gate** is the one interface every wrapper shares. Before each turn the agent asks Oxagen for pending commands and the current context. After each tool result it reports back. Harness-specific hooks add finer control on top of it. Nothing depends on them. Every adapter records the harness name and version on the run. The tier is computed from what was actually routed, never from what the adapter could do on paper.

**Wrapping a hook-based harness is one click.** On the Agents page, "Wrap Claude Code" and "Wrap Codex" produce a signed installer link with a one-time enrollment token embedded. Nothing is copied or pasted. The installer installs the `oxagend` collector and the `oxagen-hook` binary. It registers them to start at login (launchd on macOS, a user-level service or scheduled task on Windows, a systemd user unit on Linux). It writes the harness hooks and the environment block (base URL to the model proxy, the MCP endpoint). It enrolls the host with a device key and runs a one-turn smoke session. The browser page flips to "connected" when the first frame arrives, with a rollback command shown beside it. Supported from the first release: macOS (notarized package and Homebrew), Windows (signed MSI and winget), Linux (deb, rpm, and a curl script). `oxagen agent enroll` remains the scripted path for managed fleets. The enterprise managed enrollment writes locked settings instead of user settings.

### 7.3 Steering into the loop

Context enters a run at three points. All three are recorded as frames:

1. **Run start.** The policy bundle's `context.system` (published steering compiled for this agent and workspace) is injected as governed system context. Its digest, a short hash that identifies the exact content, is chained into `run.start`.
2. **Each turn.** The model proxy prepends steering as a volatile message right after the cached system block (ADR-051). It then adds context frames retrieved for the turn's goal under a token budget, with a usage report. For agents that host the protocol themselves (Stella), Oxagen is a provider and the agent does the composing.
3. **Operator steer.** A `steer` command carries text delivered at a named boundary as additional context. It is attributed to the operator and recorded as a `control.steer` frame.

**Steering can only enter at a model request.** Steering is prompt content, so the physical injection point is always a `model.request` frame. Nothing else in a run can receive text. A delivery mode therefore does not choose *where* the steer lands. It chooses *which* model request the steer rides, and whether Oxagen cuts the current step short to reach one sooner.

| Delivery mode | The event it hangs off, exactly | What it costs | Use it for |
|---|---|---|---|
| `next_step` (**default**) | The current step runs to its terminal frame. For a model call that is a `model.response`. For a tool call it is a `tool_call` result frame. The steer is injected into the **first `model.request` after that frame**. For a tool call in flight, the result is recorded first and the steer rides the same request that carries that result to the model. | Nothing. No work is discarded. | Almost everything. Redirecting a plan, adding a constraint, correcting a wrong assumption. |
| `interrupt` | Oxagen does not wait for the current step. At the model proxy an in-flight streaming response is **stopped**. The proxy returns a stop, and the partial output is recorded and **billed**, because the tokens were generated. At the tool gateway a pending call is **abandoned** and denied with reason `interrupted`. The run is then forced to a model request carrying the steer. | The partial model output, and the work of any abandoned tool call. | Harm in progress. The agent is about to do the wrong thing and the next step is too late. |
| `turn_boundary` | The steer waits for `turn_end` and enters on the **first `model.request` of the next turn**. | Nothing, but it may wait a long time. | Steering that should not land mid-plan: a change of priority, a new standing constraint. |

**An irreversible tool call in flight is never abandoned.** Nobody can un-publish a package or un-send a payment. So an `interrupt` that arrives while a tool call of side-effect class `irreversible` is executing **degrades to `next_step`**. The call completes, and the frame records `degraded_reason: irreversible_tool_in_flight`. The interface shows the degraded mode, never the requested one.

**Interrupt is not pause.** `pause` stops the run at the next boundary and waits for a human. `interrupt` cuts the current step short and at once hands the agent new context, so it keeps working in a different direction. An operator who wants the agent to stop and think uses `pause`. An operator who wants the agent to change course without losing the run uses `steer` with `interrupt`.

**What each tier can carry out.** At `gateway` tier all three modes are enforceable, because the proxy is in the path of every request. At `harness` tier there is usually no way to stop an in-flight call, so `interrupt` degrades to `next_step` and the frame says so. At `observe` tier no steering is possible at all. The command is refused, not queued. The rule in §7.1 applies: the interface shows the mode that was actually achieved.

Steering text is always evidence, quoted and cited. Oxagen itself never executes it as instructions. Whether a harness treats it as instruction is the harness's contract.

### 7.4 Halting and commands

Commands are rows in `control.commands`. They travel on the control channel, either by long-poll (a request that stays open until a command is ready) or in the next ingest response. For proxied connection points they are applied inline. **The status vocabulary is closed and shared by commands and messages**, so one delivery report reads the same whatever was sent:

| Status | Meaning | Terminal |
|---|---|---|
| `draft` | Composed in an interface, not yet sent. Never leaves Oxagen and never reaches a run. | no |
| `queued` | Accepted by Oxagen and waiting for a delivery boundary (§7.3). | no |
| `sent` | Pushed onto the control channel or injected into an outbound request. Oxagen has done its part. | no |
| `received` | The wrapper or the proxy took it. The connection point has it. | no |
| `acknowledged` | The harness confirmed it entered the loop. | no |
| `applied` | The effect is visible in the record: the `model.request` carrying the steer was made, or the pause took hold. This is the only success status. | **yes** |
| `cancelled` | Withdrawn by the operator, or superseded by a later command on the same run, before delivery. | **yes** |
| `expired` | The expiry passed with no boundary reached. Nobody withdrew it. Time ran out. | **yes** |
| `failed` | The connection point refused it, or the host was gone. | **yes** |

`applied` and `expired` earn their places against the shorter set. `applied` is the difference between *the harness has it* and *the model saw it*. That is the question §7.6 promises is always answerable. `expired` is the difference between *the operator changed their mind* and *the run never reached a boundary*. That is the difference between an operator's mistake and a fleet problem. Interfaces group `cancelled`, `expired` and `failed` as **undelivered** where a three-way split is all the reader needs.

| Command | Model proxy | Tool gateway | Hook adapter | Guarantee |
|---|---|---|---|---|
| `pause` | next request returns a paused response | next call denied with reason | next prompt and pre-tool denied | at the next boundary |
| `resume` | clears | clears | clears | immediate |
| `steer` (`next_step`, default) | injected into the first request after the current step's terminal frame | n/a | injected at the next prompt submit | after the current step, before the next model call |
| `steer` (`interrupt`) | in-flight response stopped and billed. Steer injected at once | pending call abandoned, denied with reason `interrupted` | degrades to `next_step`. Frame records the degradation | immediate, except behind an irreversible tool call |
| `steer` (`turn_boundary`) | injected on the first request of the next turn | n/a | injected at the next turn's prompt | at `turn_end` |
| `cancel` | every request refused. Run token revoked | every call refused | denied. The collector sends SIGTERM (the standard shutdown signal to a process) where it owns the process | soft cancel guaranteed. Process kill best effort and recorded |
| `revoke` (agent or host) | credential dead. All run tokens dead | same | host suspended in bundle. Denies even if the daemon is down | guaranteed while any connection point is in the path. Visible as `hooks_removed` if hooks were stripped |
| `deny_generation bump` (raises the deny generation, a counter that marks cached policy bundles as stale) | bundle stale. Non-read-only actions re-checked before they run, and fail closed | same | same | guaranteed for non-read-only tools |

Automatic halts are the same commands issued by policy. A budget breach, a schema violation on an irreversible tool, an egress-class violation, a chain break, or a detector hit (a secret in a tool argument, a forbidden path) each produce a `policy.decision` frame. Then, per workspace policy, each produces a `pause` or `cancel`.

### 7.5 Human approval

`require_approval` on a grant, a tool's risk grade, a budget threshold, or a standing rule routes an action to the **approvals queue**. The gateway parks the call (default timeout ten minutes, set per bundle). It creates an `approvals.requests` row with the canonical action, input digest, requesting span, and trust tier. It then notifies (Mission Control, Slack, email). A resolution mints a single-use **approval token** bound to the agent, run, exact action, expiry, and the approval event. The token is a Biscuit v2 token, a signed token format that can be checked without calling back to Oxagen, as decided in the wrapper design. The adapter verifies it offline and the gateway verifies it inline. Approve, deny, and expiry are all frames. The approver's reason reaches the model as the permission decision reason.

### 7.6 Messages between agents, and mass steering

Operators and agents can send messages to other agents in the same workspace. The mechanism is the operator `steer` command made general. A message is queued for a run and injected right after the steering block on the recipient's next model call. What differs is who may send, to whom, and with what authority.

- **Addressing.** `@<agent-slug>` (every active run of that agent), `@agents` (every active run in the workspace), or a run id (exactly one run). **The broadcast address is `@agents`, not `@all`.** `@all` reads as *everyone, including the humans*. This mechanism never reaches a person. It reaches the runs that are live enough to receive prompt content. A sealed run never receives a message. A run at `observe` tier never receives one, because there is no connection point to inject through. Both are recorded as undelivered with that reason. `@agents` is a grant, not a default. Operators hold it by role at **workspace** scope, so holding it in one workspace confers nothing in another. An agent holds it only if a workspace policy says so.
- **Delivery, defined precisely.** A message carries a delivery mode from §7.3. It reaches `applied` when the `model.request` that carries it is made. Otherwise it reaches a terminal undelivered status (`cancelled`, `expired`, `failed`). Every status change is a frame on the sender's run and on the recipient's run. The applied frame names the `seq` of the model request it was injected into. So "did the agent see it" is always answerable by pointing at a frame rather than by asserting it.
- **A broadcast declares a ceiling, and each connection point picks the landing.** The sender cannot know the shape of every recipient's run. One is in the middle of a tool call, one is between turns, and one is at `harness` tier and cannot be interrupted at all. So the mode on a broadcast is a **maximum urgency**, not an instruction. Each recipient's connection point resolves the strongest boundary it can actually carry out at or below that ceiling. The per-recipient frame records both the requested mode and the resolved one. A delivery report therefore reads as a list of runs. For each run it shows the mode that was achieved and the frame that proves it.
- **Authority.** An operator's message enters at the steering position with operator authority. An agent's message enters as quoted evidence with the sender named, never as an instruction. Any tool call whose arguments derive from it is taint-marked, that is, flagged as built from untrusted input (§6.7). A compromised or confused agent cannot steer the fleet into a harmful call.
- **Bounds.** A per-run inbound budget (messages and tokens), duplicate suppression by message digest, a rate limit per sender, expiry on every message, and an operator mute per agent. Every send is a governed action on the toolbelt (`send_message`, `list_messages`). The delivery queue is the commands table with command kind `message`.

### 7.7 Outbound events (Series A)

Customers subscribe to what happens in their runs and receive it in their own systems. Nothing is invented for this. Every event maps to a frame kind or an audit event.

- **Catalog.** `run.started`, `run.sealed`, `run.proven`, `approval.requested`, `approval.resolved`, `tool_call.denied`, `kill_switch.flipped`, `mandate.exception`, `budget.breached`, `incident.raised`, `context_pr.opened`, `context_pr.merged`, `ontology.activated`, `repository.indexed`, `reconciliation.exception`. New kinds are added to the catalog, never emitted ad hoc.
- **Subscriptions** at workspace or organization scope name the event kinds and optional filters (agent, operator, severity). Only those events are emitted. Everything else never leaves.
- **Two delivery modes on one unique endpoint per subscription**, generated at creation. Push: Oxagen sends a signed webhook, an HTTP request to the customer's URL when an event happens. It is signed with HMAC, a keyed hash that proves who sent it, using a rotating secret. It carries a delivery id for safe retries, is ordered per run, and is delivered at least once with backoff. A dead-letter view, the list of deliveries that failed after all retries, sits on the Audit page. Pull: the customer reads from an Oxagen-hosted streaming endpoint unique to the subscription, with a replay window.
- **Payloads** carry ids, kind, time, scope, and a compact body with a link to the run and frame. Never raw prompt or tool bodies. Redaction rules apply.
- **Governed.** Creating or changing a subscription is a governed action with the third-party egress class (`set_event_subscription`, `list_event_subscriptions`). Every delivery is audited.

---

## 8. Runs and frames

### 8.1 Run

A run starts when a wrapped agent opens a session. It also starts when a proxied first call arrives with a fresh run token. The run carries a trusted identity that only server code builds (the `RunSpecV2` pattern). That identity holds the operator (`initiating_principal`), the agent principal, the agent version digest (a digest is a hash that names exact content), the authorization snapshot id, the repository and base commit, the retention policy version, the enforcement tier (computed at seal, the signed close of a run), the governance mode, and an optional **task reference**. A task reference is a Linear issue, a GitHub issue or PR, or a free-text goal. It lets spend be reported by what the work was for. Attempts are immutable. A resume or fork creates a new attempt linked to the prior one. Turns and steps are not rows of their own. They are derived from frames and materialized in the rollups (§12.7). `turn_start`/`turn_end` bound a turn. A model request/response pair or a tool requested/result pair is a step.

### 8.2 Frame

A frame is the `oxagen.frame/1.0` envelope, kept as is. Its fields are `event_id` (a ULID, a time-sortable unique id), agent, run, attempt, dense `seq` from 0, `ts` (protocol timestamp profile), `kind`, `fidelity`, `span`, `body`, `content { digest, bytes_ref?, redactions[] }`, `prev_hash`, and `hash`. Kinds are the wrapper vocabulary (`agent_start`, `turn_start`, `tool_requested`, `tool_call`, `llm_call`, `policy_decision`, `approval_request`, `approval_decision`, `token_issued`, `token_use`, `token_denied`, `file_io`, `network`, `command`, `subagent_start`, `subagent_stop`, `agent_stop`, `error`, `telemetry_gap`, `checkpoint`, and the `oxagen:` lifecycle kinds) plus the gateway kinds this spec adds:

| Kind | Emitted by | Body |
|---|---|---|
| `model.request` | model proxy | provider, model, full request (messages, tools, params), injected steering digests, `injected_steer_ids[]` naming the `control.steer` frames this request carried, context frame ids and usage report, provider request id |
| `model.response` | model proxy | full response, stop reason, usage by token class, latency, **cost record** (§12) |
| `context.assembled` | model proxy or Stella | budget, context frame ids by `(provider_id, frame_id, content_digest)`, usage report, composition digest |
| `record.appended` | exchange provider | record id, lineage id, record hash, kind |
| `skills.searched` | gateway | query digest, resolved config version, returned ids, withheld count by reason class (never the withheld names), load cost, replay grade |
| `skills.resolved` | gateway | the config version a run pinned at start, sources on, belt mode, cut-off, load budget |
| `skills.loaded` | gateway | `id@version`, digest, token cost, the decision that admitted it |
| `control.interject` | control channel | the question put to a person, why the loop stopped (e.g. `unbound_repo`), the timeout and what it falls back to (`deny`) |
| `control.answer` | control channel | the answer, who gave it, and the frame it unblocked |
| `reflection.captured` | out of band, after the seal | rubric axes, self-grade against the record, contradictions citing frames. **Outside the sealed chain and never replayed on a fork** (§quarantine, ADR-090) |
| `control.command` | control channel | command, issuer, status (§7.4), the boundary it was applied at |
| `control.steer` | control channel | steer text digest, issuer, `requested_mode` and `delivery_mode` (§7.3), `interrupted` (bool) with `interrupted_step {kind, seq}` when true, `degraded_reason` when the requested mode could not be honoured, `delivered_at_seq` (the `model.request` that carried it), status |
| `proof.observed` | witness runner (§8.5), the isolated service that runs witnesses, or Stella's local ladder when the run came through Stella | witness id, oracle kind (the type of check the witness makes), target and PR refs and shas, normalized command digest, verdict, fail fingerprint (a hash of the failure output), tamper exclusion (a check that the witness was not altered), disclosure grain (how much detail the worker is told), runner attestation (the runner's signed statement of what it ran) |

**Bodies are content-addressed blobs**, stored and found by the hash of their bytes. `content.digest` is SHA-256 over the exact bytes. `bytes_ref` points to the encrypted object. The frame node in the graph holds everything except the bytes. Redaction runs before the bytes are written. It is recorded per frame with the digest of what was removed. A redacted body can therefore still be verified against its digest.

### 8.3 Chain, checkpoints, attestation

- `hash = SHA256(prev_hash ‖ canonical(envelope without hash))`. This forms a hash chain, where each frame's hash locks in the frame before it. `seq` is dense, with no gaps. A gap is a `telemetry_gap` frame, never a repaired sequence. The same `seq` with a different hash is refused and reported as a security incident. It is never overwritten.
- **Checkpoints**, signed markers that fix the chain so far, are taken every N frames or T seconds. The producer's key signs them (host device key or agent credential fingerprint). Oxagen countersigns them on ingest.
- **Seal** at run end, for every terminal outcome. The seal computes an RFC 6962 Merkle root, one hash that commits to every frame hash. It writes the archive segment (§13). It then produces the **run attestation**: an Ed25519 signature (a public-key signature) by the organization's attester key over `(run_id, attempt_id, frame_count, merkle_root, archive_segment_digest, enforcement_tier, completeness_gaps)`. Keys live in KMS, a managed key storage service. Key ids and validity windows are published per organization, so a customer can verify an export offline.
- **Tamper-evidence, stated precisely.** Gateway-observed frames are Oxagen-attested. Client-attested frames (hooks, SDK emitters, drains) are producer-signed and Oxagen-countersigned at ingest. For those, Oxagen attests receipt and chain integrity, not the truth of the content. Every export and every UI badge says which.

### 8.4 Replay

Every run carries a **replay grade**: the strongest thing a person can do with the recording. It is computed from completeness gaps. The vocabulary is closed and ordered, weakest first. Each word is the verb on the control it unlocks:

| Grade | What you can do | What it needs | Available on |
|---|---|---|---|
| `inspect` | Read the chain: every frame, its kind, its digests, its cost, its policy decision, its timing. A reader can see that the agent called a tool and what it cost, but not what it said. | Frames only. Always true of any run Oxagen recorded. | a `digest_only` workspace, an `observe`-tier run, or any run with gaps in its bodies |
| `view` | Step through the run and read it: what the agent was told (system context, steering, context frames with citations), what it asked, what the model returned, what tool it called with what input, what came back, which policy decided what, and what it had cost by that point. | Frames plus blob bodies. | any run whose bodies were retained |
| `fork` | Re-run from frame N with the recorded context and steering. Tool results are served from the recording as a cassette (a fixed tape of recorded answers), and a new model call is made. This is how to ask "would a different rule have changed this?" and how a failure becomes a test case. | `view`, plus tool result bodies. | any `gateway`-tier run with bodies |
| `retry` | Run the task again from the start on a deterministic ladder. Oxagen records the second run and offers **bisect** between any two runs of the same task. | `fork`, plus a harness that can reproduce a run. | Stella |

The grade names the strongest verb, and every weaker verb comes with it. A `fork` run can also be viewed and inspected. The interface renders the recorded grade and never a stronger word, per the rule in §7.1 that a grade is reported as it is.

`retry` here is a replay grade. It has nothing to do with the provider retries counted on a model call in §12.6. The interface labels those *provider retries* wherever both could be read at once.

**The transport: playing a run back.** Both `view` and `fork` present the run as a transcript with a transport above it. The transport can scrub, step, play, and play at ×1, ×1.5, ×2 and ×4. Four things make that work, and three of them are already in the record:

- **Position** is the frame's dense `seq`. **Elapsed** is its `ts` against the run's first frame. Both exist on every frame, so seeking is a read at a `seq` and needs nothing new.
- **Playback speed** divides the real interval between frames, derived from consecutive `ts`. But **real runs are mostly waiting**. A forty-second tool call is forty seconds of nothing, so literal wall-clock playback is unwatchable. Playback therefore **compresses idle**. Any gap longer than the compression threshold (default two seconds, per workspace) collapses to the threshold. The transport shows true elapsed time beside the position, so compression is never mistaken for speed. A run's real duration is always readable. Only the waiting is skipped.
- **Cumulative cost at a position** is a prefix sum over the cost records on the frames up to that `seq`. The player computes it on load. It is not stored. `cost.run_totals` is the whole-run figure and stays that way. A stored per-frame running total would be a second copy of a number the frames already carry.
- **There is no stop.** The transport moves the *viewer*. The run controls move the *run*. A stop button would sit one pixel from `cancel` and mean something entirely different. So the transport carries play, pause, step, scrub and speed, and nothing that can touch the run. On a live run the transport's play state is *following the head*. Scrubbing backwards detaches from the head, and the interface says so. The run keeps going either way.

### 8.5 Proof: witnesses, oracles, and the flip

A run is **proven** when a **witness** (a check written by Oxagen, not by the worker) **fails on the target branch and passes on the pull request**. The witness runs in an environment the worker never sees. The worker learns nothing from it but the word pass or fail. Those flips stamp the run. Stamped runs are the labeled data that owned intelligence is trained on. The mechanism is Stella's witness protocol (the flip oracle, tamper exclusion, the deterministic-first ladder, the feedback airlock). Oxagen hosts it so it applies to every wrapped agent. Three requirements apply in every case.

**The three invariants**

1. **The flip is measured against the PR's target.** The witness runs twice in the same environment. First it runs on the merge-base of the PR against its target branch (the production branch from §11.4, or whatever branch the PR targets). There it must **fail**. Then it runs on the PR head. There it must **pass**. A witness that passes on both proves nothing about the change and is recorded as `unmoved`. One that fails on both is `unsatisfied`. Only `Failing` on the target followed by `Flipped` on the PR head, for the same normalized command, credits a proof.
2. **The worker never sees the witness or its environment.** Witnesses are authored, stored, and executed in a **witness runner**. That runner is an isolated execution plane with its own credentials, no network path from the worker's run, and no filesystem the worker can reach. The witness artifact is not in the repository, not in the PR, not in any context frame, and not reachable through any tool on the tool gateway. A tool call whose target resolves to witness storage is denied by policy and raises a `witness_probe` incident on the run. The witness runner does not accept the worker's run token.
3. **Only pass or fail comes back.** The witness runner reports to the worker at disclosure grain `L0`. That means verification passed, or it failed, and nothing else. No test name, no assertion, no expected or actual values, no reproduction, no path. A workspace may raise the grain as an explicit policy decision by a human, recorded as a security event. `L1` names the criterion, `L2` describes a symptom, and `L3` hands over a regenerated reproduction. The default is `L0`. Any brief at any grain passes the scrubber. The scrubber degrades a brief one grain rather than emit one containing a test identifier, a literal value, or a witness path. Every brief is recorded beside the sealed material it was redacted from, so disclosure is auditable.

**Oracle kinds.** A witness is an oracle plus a normalized command. Oxagen supports several kinds, ordered by how conclusive a red result is. The ladder is deterministic first, and a deterministic red is terminal on its own:

| Oracle | What it asserts | Typical source |
|---|---|---|
| **Test flip** | a test the witness adds or targets fails on the target, passes on the PR | the task's acceptance criteria, the issue, the PR description |
| **Build or type** | the target fails to compile or typecheck against a new interface the PR must provide, the PR succeeds | a declared API change |
| **Property** | a property-based check over generated inputs fails on the target, passes on the PR | an invariant named in the task |
| **Golden or snapshot** | a captured output differs from the expected artifact on the target and matches on the PR | fixtures, rendered documents, API responses |
| **Contract** | an HTTP or schema contract check fails on the target, passes on the PR | an OpenAPI or JSON Schema change |
| **Metamorphic** | a relation between two runs of the program holds on the PR and not on the target | numerical, data-transform work |
| **Behavioral probe** | a scripted interaction (CLI, browser, service) reaches a state on the PR that the target cannot | user-facing features |

A model's opinion that the change looks right is not an oracle. The witness *author* is a model call (complex tier, §4.5), because it creates the oracle. The *verdict* never is.

**Authoring.** Authoring is demand-driven. A witness is written when a run declares a task with acceptance criteria (an issue, a PR, a spec), or when a workspace policy requires proof for a class of change. The author reads the task, the target-branch code graph (§11.4), and the workspace's steering. It produces a witness with its command, its oracle kind, and its expected fail mode on the target. Before the ladder runs, the witness is **proven to fail on the pristine target**. A witness that does not fail there is discarded and re-authored, and never charged to the worker. The witness's filesystem identity is fingerprinted at that moment (tamper exclusion). So a PR that edits the test infrastructure, adds a skip marker, or otherwise moves the ground under the witness is detected. It is recorded as `tampered` rather than credited.

**Anti-overfitting beyond the airlock.** A task may carry more than one witness. The worker is told only the aggregate verdict, never which one failed. A share of witnesses per workspace is held out and never reported to the worker at all, only to the record. Repeated identical failure fingerprints tighten disclosure further if a grain above `L0` was enabled. Retries against the witness are capped per run by policy. A run that exhausts them is `unsatisfied`, not retried elsewhere.

**Stamping.** Every witness run is a run of its own (agent: the witness runner service principal, operator: the worker's operator). So its cost is attributed and its frames are replayable. Its verdict lands on the worker's run as a `proof.observed` frame:

```json
{
  "kind": "proof.observed",
  "body": {
    "witness_id": "wit_…", "oracle": "test_flip",
    "target_ref": "main", "target_sha": "…", "pr_ref": "refs/pull/482/head", "pr_sha": "…",
    "command_normalized_digest": "sha256:…",
    "target_result": "fail", "pr_result": "pass", "verdict": "flipped",
    "fail_fingerprint": "sha256:…", "pass_output_digest": "sha256:…",
    "tamper_exclusion": "held", "disclosure_grain": "L0",
    "witness_run_id": "run_…", "runner_attestation": { "key_id": "…", "signature": "…" }
  }
}
```

The verdict vocabulary is closed: `flipped`, `failing`, `unmoved`, `unsatisfied`, `tampered`, `unverified` (the runner could not reach a conclusion, never resolved by a model), `waived` (nothing changed and nothing tried, per policy). Only `flipped` marks a run proven. The seal signs the proof frame with the rest of the chain. The witness runner's own attestation is embedded. So a proof can be verified offline without trusting the worker's harness at all.

**What a proven run leaves behind.** For each proven run, the seal stores the tuple a training example needs: the task and its acceptance criteria, the context frame and record ids the worker was given, the diff digest against the target, the witness verdict with its oracle kind, and the cost. That is the labeled example. It is produced as a side effect of the work, with no person reading it. Nothing else about training is built in v1. §12.8's proven spend and productive ratio read the same frame.

**Where this runs.** The witness runner is the one execution plane Oxagen operates. It is not the worker's runtime, and ADR-043 stands. It runs witnesses, not agents. It has no model access except the author call. It is ephemeral per witness run. For customers on a dedicated data plane, it runs inside their plane.

---

## 9. Context records: how agents learn

Agents do not write frames as memory. When an agent wants to remember something, it appends a **context record**. The record goes through Oxagen's exchange-provider endpoint (`context/append`, lifecycle profile). Any harness can send one. Stella sends records natively. Other agents use the SDK wrapper's `remember()` and `propose()` calls, or an MCP tool on the tool gateway.

- **Kinds accepted from agents:** `observation`, `memory`, `knowledge` (fact, assumption, decision), `evidence`, `record_proposal`, `context_use`, `context_use_feedback`. An agent may only *propose* a `directive`. It becomes active only through a Context PR (§10). The promoter writes `promotion_event`, never an agent.
- **Identity and hash.** A hash is a short fingerprint computed from a record's bytes. `record_hash` is SHA-256 over the RFC 8785 canonical bytes, with the hash member removed. RFC 8785 is the standard that defines one canonical, meaning fixed and repeatable, byte layout for JSON. The protocol and Stella compute it the same way. Oxagen adopts Stella's null-stripping divergence so all three agree. `record_id` is derived from the content. A correction is a new record on the same `lineage_id`. A lineage is the chain of records that revise one idea over time. Superseded is derived, never stored.
- **Attestation.** Oxagen countersigns every accepted record. To countersign means to add its own signature beside any existing one (`RecordAttestation`, detached, Ed25519). An agent that holds a key may sign first. The graph keeps both signatures.
- **Scope.** `scope` uses the protocol's portable keys (`organization_id`, `workspace_id`, `repository_id`, `user_id`, `session_id`, `task_id`). `sharing_scope ∈ {user, repository, workspace, organization}` widens visibility. The sharing scope sets how far beyond its author a record can be seen. Oxagen enforces sharing authorization before persistence and on every read, per the profile.
- **Provenance.** Provenance is the trail that shows where a record came from. `provenance.source_refs` point at frames (`frame:<run>/<seq>`) and at other records. `evidence_links` point at frames or tool outputs by digest. An evidence link is a pointer to the proof behind a record. So every learned thing walks back to the exact frame that taught it.
- **Retention.** Oxagen honors or refuses `requested_retention` before persistence. A refusal returns `retention_rejected`. The accepted value is stored on the record.
- **Storage.** Records are `:Record` nodes in the organization's graph. Each node carries `ws`, `kind`, `lineage_id`, `record_hash`, `status`, and temporal fields. Typed edges connect the nodes: `DERIVED_FROM → :Frame|:Record`, `EVIDENCED_BY → :Frame`, `SUPERSEDES`, `REFINES`, `CONTRADICTS`, `PROPOSES → :Record`, `PROMOTED_BY → :Record(promotion_event)`, `ABOUT → :Entity`.

### 9.1 Reflection

After every seal, the reflector reads the run. The reflector is a governed service agent tool, metered like any other. It produces:

- `observation` records for notable events (a rule violated, a tool that failed twice, a file convention discovered). Each carries evidence links to frames.
- `memory` records for what the agent itself asked to remember during the run.
- `context_use_feedback` for each context frame that was rendered, cited, or ignored. This closes the loop on retrieval quality.

Reflection uses a model. It runs through the model proxy under a service principal. Its own cost is therefore a frame in a run of its own.

### 9.2 Aggregation and promotion

The promoter aggregates records across runs by lineage and by entity. A candidate becomes a `record_proposal` when a workspace policy's thresholds are met. The thresholds are: support across at least N runs and M distinct agents, confidence above a floor, no active contradiction, and no open proposal on the lineage. The thresholds belong to the product, not the protocol. A proposal carries `proposed_kind` (a directive kind or knowledge kind), a rationale, the supporting record ids, and the sharing scope it asks for. Proposals appear in Mission Control and become Context PRs (§10.3). Ranking uses citation pressure and confidence with decay. Citation pressure is how often later records cite a record. Decay means older support counts for less as time passes. Both come from the two-axis memory model.

---

## 10. The repository, steering, and Context PRs

People trust pull requests, proposed code changes that named reviewers approve before they merge. Every engineering organization already runs them, with named reviewers, required checks, and a history the customer can verify without Oxagen. So Oxagen governs the records that steer agents the same way teams govern code. Each record is authored in the workspace's main repo, proposed as a pull request, and published on merge. The graph remembers everything about those records. Git decides what is in force. Section 4.2 states the rule. This section describes the mechanism.

### 10.1 Repositories: one main repo, any number of linked repos

A workspace links to one or more GitHub repositories through the Oxagen GitHub App, an installed integration with its own repository access. Each link records the installation, the repository, the **production branch**, whether the repository uses GitHub Issues, and a `role`. The production branch follows §11.4. GitHub's default branch, the branch a repository treats as its primary line, is offered as the suggestion. The customer confirms or changes it. If GitHub's default branch changes later, Oxagen raises a prompt rather than silently moving the binding.

- **`main`**, exactly one per workspace, required at creation. The main repo is where the workspace's steering and configuration are managed in source control. That covers published steering records, the promotion ledger (the log of each promotion event), governance mode, and the workspace's Oxagen configuration file. That file is `.oxagen/workspace.toml`. It declares linked repos, tool servers, budgets, and ontology sources. Oxagen reconciles those declarations against Postgres and reports drift, any gap between the file and the live state. Workspace-scoped Context PRs are opened here. A workspace without a main repo cannot exist. Changing which repo is main is an org-owner action with approval, recorded as a security event.
- **`linked`**, zero or more. These are the repositories the workspace's agents work on. Oxagen ingests each one into the graph (§11.2). Each is a valid `resource_scope.repositories` target in grants. Each may carry its own `.oxagen/rules/` holding records with `sharing_scope = "repository"`. Those records steer only runs on that repo. Repository-scoped Context PRs are opened on the linked repo itself.

A repository may be linked to more than one workspace in the same organization. It is main for at most one. The graph node for a repository is shared across the workspaces that link it. Each link edge sets `ws`, so isolation holds per workspace.

### 10.2 On-disk layout: `.oxagen/`

The directory is `.oxagen/`. The word `.stella` never appears in an Oxagen product, in a customer's repository, or in this specification's file names. The file format inside it is the context-record format Stella already implements and validates. Nothing is invented. Only the directory name is Oxagen's.

```
.oxagen/
  workspace.toml             # linked repos, tool servers, budgets, ontology sources (main repo only)
  rules/
    governance.toml          # mode = solo | team | regulated; separation flag
    promotions.jsonl         # hash-chained promotion ledger (regulated mode)
    ctx.<set>.<slug>.toml    # one published record per lineage id
  proposals/*.toml           # candidates; steer nothing
  agents/<slug>.toml         # agent definitions, one per agent (§6.2); harness files are generated beside them
  ontology/                  # optional, §11.8: one file per class and relation type
```

Each record is one TOML file, a plain-text settings format. The file holds `schema = "context-record/v0.1"`, the record's `lineage_id`, kind, statement, steering and enforcement blocks, truth probes, and `record_hash`, a fingerprint of the record's content. Custom agents never parse the file. Oxagen serves published records as context frames and as compiled steering text. So the file format is a publication concern, not an integration concern.

**Stella symlinks, it does not copy.** When Stella initializes in a repository and finds `.oxagen/`, it creates symlinks, pointers to another path rather than copies. The same happens when a workspace is bound after Stella was already initialized there. The symlinks are `.stella/rules → ../.oxagen/rules`, `.stella/proposals → ../.oxagen/proposals`, and `.stella/agents → ../.oxagen/agents`. With them, Stella's loader, its CI validation, and `stella context propose` work unchanged on the Oxagen-governed files. There is no second copy that could drift. `.stella/private/` stays a real, gitignored directory. Oxagen reads `.oxagen/` and nothing else. Whatever sits under `.stella/` is invisible to Oxagen, and Oxagen never inspects it. The symlink is Stella's responsibility (Stella issue #6507). Stella refuses to initialize a second rules directory beside an existing `.oxagen/`.

The layout is the same in the main repo and in a linked repo. What differs is the sharing scope. Records in the main repo carry `sharing_scope = "workspace"` and apply to every run in the workspace. They may instead carry `organization` when the org allows a workspace to publish org-wide. Records in a linked repo carry `sharing_scope = "repository"` and apply only to runs whose repository binding is that repo. A linked-repo record that claims workspace scope fails the checks. Precedence at run time follows Stella's authority rule. Repository records may narrow what workspace records allow. They may never widen it.

**Published** means the record file exists under `.oxagen/rules/` on the default (or context) branch of the main repo. For repository-scoped records, the file exists on that branch of the linked repo. The graph indexes every published record by `record_hash` and by the repo and commit it came from. Oxagen verifies the index against the merged commit. A mismatch is a `steering_drift` incident that blocks delivery of that record until resolved. The graph never silently outranks git for steering. Git never holds anything but steering and configuration.

### 10.3 Context PR lifecycle

```
proposal (graph)  →  Context PR (GitHub)  →  checks  →  review per mode  →  merge  →  promotion_event (graph + ledger)  →  published (index)  →  delivered (bundle, frames)
```

1. **Open.** The promoter, a person in Mission Control, or `stella context propose` opens a branch `context/<lineage>` with the single record file. It also opens a PR. The PR body carries the rationale, the supporting record ids, evidence links, and an Oxagen check-run link. One concern per PR. The target is the main repo for workspace-scoped records and the linked repo for repository-scoped ones. The promoter picks the scope from where the evidence came, either all supporting runs on one repo or across repos.
2. **Checks** are Oxagen GitHub App check runs with the same rules as `stella context validate`. They cover schema, lineage uniqueness, `record_hash` recomputation, and a secret and PII scan. They detect conflicts against active records, so a `forbid` against an active `require` on the same subject fails. They run truth probes where declared. They enforce the `constraint_effect ∈ {require, forbid}` rule, which means a record can never grant authority.
3. **Review.** In `solo` mode, the author may merge. In `team` mode, a code-owner review is required. In `regulated` mode, a named approver from a role must approve, and Oxagen records that as an accountable approval. A `promotions.jsonl` entry is appended in the same merge.
4. **Merge** triggers a `promotion_event` record in the graph. That record holds `from_status`, `to_status`, subject lineage, approver, PR url, and commit sha. Merge also triggers re-indexing from the merged commit, a bundle version bump for the workspace, and a `steering_published` audit event.
5. **Retirement** is a Context PR that sets `status = "archived"` in place. Files are never deleted.

Oxagen honors enforcement grants only when they appear in the promotion ledger, never from a private local approval. An enforcement grant is a `blocking` directive that arms a tool guard. This rule carries over from Stella's authority rule.

### 10.4 Delivery

Published records reach agents three ways, all recorded:

- **Bundle context.** Compiled steering text in the signed policy bundle. `must`/`should` records sit in the stable prefix. `may`/`info` records are selected by relevance.
- **Turn injection.** The model proxy's volatile steering message (ADR-051).
- **Context frames.** Oxagen's provider serves them as `fact` and `memory` context frames. Each carries provenance to the record and the commit. Valid-from is set to the merge time, so `as_of` queries are exact.

Oxagen measures the effect of each published record: the runs that rendered it, cited it, or violated it, and the proof rate before and after publication. Records with no effect after a window are surfaced for retirement.

---

## 11. The knowledge graph and dynamic ontologies

### 11.1 Layers in the organization database

| Layer | Labels | Purpose |
|---|---|---|
| Ontology (meta) | `:Ontology`, `:OntologyVersion`, `:Class`, `:Property`, `:RelationType` | What kinds of things exist, per workspace. Every version is indexed from the files in git (§11.8), with proposal provenance (a trace of where each change came from) |
| Source | `:Source`, `:SyncRun`, `:SourceRecord` | Raw records as ingested, with connector id, external id, digest, and sync time |
| Entity | `:Entity` + dynamic class label (`:Customer`, `:Ticket`, `:Repository`, …) | Resolved entities, with `DERIVED_FROM → :SourceRecord` provenance |
| Context | `:Record` and its edges (§9) | What was learned, proposed, and published |
| Run | `:Run`, `:Attempt`, `:Frame`, `:Checkpoint`, `:Seal` | The run record (§8) |
| Reference | `:Principal`, `:Agent`, `:Workspace` | Reference nodes keyed by public id only. Their fields live in Postgres |

Every node carries `id` (public id), `ws`, `created_at`, `valid_from`, `valid_to`, `recorded_at`, and `is_system`. Embeddings (numeric vectors that capture the meaning of text) live in Neo4j native vector indexes, which are indexes built for nearest-neighbor search over those vectors. There is one per label and embedding model (§11.5). A full-text index per label sits beside it for hybrid retrieval.

### 11.2 Ontology engine

1. **Ingest.** A connector syncs a source into `:SourceRecord` nodes. The cursor and health live in Postgres, and the records live in the graph, so the connector dual-write pattern carries over. Three connectors ship in v1: GitHub (§11.4: every linked repo and the main repo), Linear (teams, projects, issues), and Postgres (tables selected by the customer).
2. **Profile.** A deterministic profiler reads a sample of source records per source type. It computes candidate classes (from record types and tables), properties (names, inferred types, cardinality, nullability), relation types (foreign keys, reference fields, mention patterns), and natural keys (the fields that identify an item on their own). A model names and describes candidates only after the deterministic pass. It never invents a class the profiler did not see.
3. **Propose.** The result is a pull request on the main repo (§11.8). The branch changes the ontology files. The PR body holds a diff against the active version (classes added, properties changed, relations added) and the migration plan for existing entities. Proposals from the engine, from the Ontology page, and from a hand edit all take this path, with the same checks a Context PR gets. The graph records the proposal's provenance: which source records and which profiler run inferred each change.
4. **Activate.** Merge is activation. The merged manifest freezes a new immutable version and moves the workspace's pin. The graph then indexes it by digest, applies labels and constraints, migrates entities, and stamps `valid_from`. Nothing activates any other way. Prior versions remain queryable `as_of`.
5. **Materialize.** This step builds the entities. Entities are upserted with natural keys and resolved across sources. This entity resolution (matching the same entity across sources) uses email, URL, external id, and a model-assisted match. The confidence threshold for that match is a workspace setting. Every entity is always linked to its source records.

The GitHub connector ships a built-in ontology fragment (`Repository`, `Branch`, `Commit`, `PullRequest`, `Issue`, `Release`, `File`, `Symbol`, and their relations). The fragment is merged into a workspace's ontology when the first repo is linked. Customers extend it and never redefine it.

### 11.3 Oxagen as a protocol provider

Oxagen exposes one provider per workspace on the tool gateway host. The provider offers `context/query` over entities, records, and runs, with kinds `fact`, `doc`, `memory`, `episode`, and `graph`. It also offers `context/verify` and the lifecycle operations `append`, `get`, and `resolve`. It declares `data_flow.egress: true` with scope `org-tenant`. Egress means data leaving the organization's boundary, so a host gates the provider behind consent as the protocol requires. Frames carry provenance to the entity, source record, connector, and digest. `token_cost` is the protocol's exact accounting. `valid_from`/`valid_to` come from the entity's temporal fields. Conformance runs in CI against the pinned protocol fixtures (ADR-035 pattern).

---

### 11.4 GitHub: events in, code graph up to date

Linking a repository does four things, in this order. Each is visible on the Ontology page with its own status.

**1. Confirm the production branch.** The link dialog shows GitHub's default branch. It asks the customer to confirm that branch as the production branch or pick another (`main`, `release`, `production`, whatever they ship from). The production branch is the only branch whose commits update the code graph. If GitHub's default branch later changes, the App receives the `repository` event, records it, and prompts the workspace owner. The binding never moves on its own.

**2. Subscribe to events.** The App subscribes the repository to every event the product uses. It records each delivery as an `:Event` node in the graph, linked to the entity it concerns. The node holds the delivery id, the actor, the timestamp, and the payload digest. The payload itself is a source record. Events used in v1:

| Event | Why it matters |
|---|---|
| `push` | Commits to the production branch drive the code graph. Commits to other branches are recorded as commits only |
| `pull_request`, `pull_request_review`, `pull_request_review_comment` | PRs are entities. A merge into the production branch is a verified outcome for the run that opened it (§12.8). Reviews are evidence |
| `issues`, `issue_comment`, `label`, `milestone` | Issues are entities and task references for runs (§8.1) |
| `check_suite`, `check_run`, `workflow_run` | CI results attach to commits and PRs and feed proof and findings |
| `release`, `create`, `delete` | Releases and branch or tag lifecycle |
| `commit_comment` | Evidence on a commit |
| `repository`, `installation`, `installation_repositories` | Renames, default-branch changes, permission changes, and uninstalls. Each prompts, and none silently alters a binding |

Delivery is by webhook (GitHub sends each event to Oxagen over HTTP) into a durable job, idempotent on GitHub's delivery id. There is no polling and no cron. Missed deliveries are detected from the events themselves. Every `push` carries the previous head. If that head does not equal the head Oxagen last recorded for the branch, the job fetches the compare range and processes the gap before the new push. GitHub's own redelivery is enabled for the App as the second line.

**3. Import issues.** If the repository has Issues enabled, the link runs a one-time backfill. The backfill is paginated, rate-limit aware, and resumable, with a progress bar on the Ontology page. It creates an `:Issue` entity per issue with labels, milestone, state history, and the issue-to-PR links GitHub exposes. Assignees map to principals where a GitHub login matches a member. After the backfill, issue events keep the entities current. An issue becomes a run's task reference automatically when the run's branch name, PR body, or commit message references it (`#123`, `Closes #123`, or the issue URL). Spend then rolls up to the issue without anyone tagging anything.

**4. Build and keep the code graph.** On link, the indexer clones the production branch head. The clone is shallow and goes into ephemeral storage that is discarded after indexing. The indexer builds the code graph: `:File` and `:Symbol` nodes with `DEFINES`, `IMPORTS`, `CALLS`, and `REFERENCES` relationships. Each is stamped with the commit that introduced it (`valid_from`) and, on removal, the commit that removed it (`valid_to`). Parsing uses tree-sitter grammars (a parser library with one grammar per language). These are the same grammars the protocol's reference provider uses, so symbols agree with what Stella sees locally. Every `push` to the production branch then updates the graph **incrementally**. Only the files in the push's diff are re-parsed. Changed symbols are versioned rather than overwritten. The repository's recorded head moves forward in the same transaction. No other branch is ever parsed into the code graph. Pull requests from feature branches are recorded as entities with their diff metadata, and nothing more.

A **manual sync** (`sync_repository`, a governed action on the Ontology page and the API) does a full re-index of the production branch head. It is idempotent. It archives anything the full pass does not see, with the current commit as `valid_to`. An operator reaches for it after a force-push, a history rewrite, or a doubt. It is never scheduled.

Division of labor with Stella: the graph holds the production truth of each repository and its history. Stella's local provider serves working-tree context (uncommitted changes, feature branches) as context frames during a run. Both cite the same symbols, because both use the same grammars. A run's frames show which one a piece of context came from.

### 11.5 Embeddings and semantic retrieval

Embeddings run on the **Voyage AI API**, called directly (not through OpenRouter). They run under the organization's funding source like every other model call: on the platform key by default, and on the customer's Voyage key when they set one. Every embedding request is a model call with a cost record (§12.3, token class `input` only). It is also a frame in the run of whatever produced it (an ingest job, a reflection, a query). Embedding spend is therefore attributed like everything else.

**Models, one space per family.**

| Content | Model | Why |
|---|---|---|
| Entities, records, issues, PRs, short documents | `voyage-4` for documents, `voyage-4-lite` for queries | The voyage-4 family shares one 1024-dimension space with a 32K context. A cheap query embedding can therefore search an index built with a stronger document embedding (asymmetric retrieval). `voyage-4-large` is a per-workspace upgrade for the entity index when recall matters more than cost |
| Long documents and source records | `voyage-context-3`, chunks of about 800 tokens with 100-token overlap, embedded as one grouped document | Contextualized chunk embeddings (each chunk is embedded with knowledge of the document around it) make a mid-document chunk findable |
| Code: files and symbols from the code graph (§11.4) | `voyage-code-3` | Trained for code. Symbol embeddings cover the signature, docstring, and a bounded body window |
| Reranking (a second model re-scores the top candidates) | `rerank-2.5` over the top 50 hybrid candidates | The last mile of precision, paid only on the candidates that survive retrieval |

Rules:

1. **One model per index, never mixed.** An index is named by label and model (`entity_voyage4_1024`, `symbol_voyagecode3_1024`, `chunk_voyagecontext3_1024`). A model upgrade is a migration. Build the new index alongside the old one, backfill in batch, and cut retrieval over when the retrieval evaluation (below) is at least as good. Then drop the old index. Queries never span two models.
2. **Embed the canonical text, store its digest.** Each embedded node carries `embedding_model`, `embedding_dims`, `embedding_input_digest`, and `embedded_at`. The canonical text is rendered deterministically per label. An entity card holds class, name, key properties, and a one-line relation summary. A record holds statement and rationale. A symbol holds signature, docstring, and body window. A node is re-embedded only when its input digest or the model changes. An ingestion that touches unrelated properties therefore costs nothing.
3. **Batch for backfills, realtime for the edge.** Backfills and re-indexes use Voyage's batch pricing. Incremental updates from a push, a sync, or a record append embed in the same job that wrote the node.
4. **Redact before embedding.** Redaction strips sensitive values from text before use. The same detectors that run on tool output run on embedding input. PII classes a workspace marks as never-embed are dropped from the canonical text. Embedding input leaves the organization's plane to Voyage and is declared as third-party egress in the provider's data flow. A customer that cannot accept that sets `embed: off` for a label and gets full-text retrieval only for it. Vectors never leave the organization's database. Erasure deletes the subject's vectors with the subject's nodes.
5. **Isolation.** Vector indexes live in the organization's own database (§5.3), so there is no cross-tenant nearest neighbor by construction. Inside an organization, the workspace filter is applied after the approximate search with an over-fetch factor (four times k, doubling once if the filtered set is short). Retrieval falls back to full-text when a workspace's share of an index is too small for that to converge.

**Retrieval is hybrid, then reranked, then cited.** A semantic request runs a vector search and a full-text (BM25, keyword-based) search over the allowed labels. It fuses the two ranked lists by reciprocal rank (each result's score comes from its position in each list), reranks the top 50 with `rerank-2.5`, and returns the top k as context frames. Each frame has a kind by label (`fact` for entities and knowledge records, `memory` for memory records, `doc` for chunks, `symbol` for code, `episode` for run summaries). Each frame also carries provenance to the node, its source record and digest, temporal validity from the node, a score normalized into the protocol's provider-local range, and the exact token cost. The frames pass the same conformance checks as any provider's.

**Quality is measured, not assumed.** Every run's `context_use_feedback` records (§9.1) say which frames were rendered, cited, or ignored. From them, Oxagen maintains a per-workspace retrieval evaluation set (query, cited frames). It reports recall at k and the citation rate per index on the Ontology page. Model upgrades, chunking changes, and reranker changes are gated on that set. The findings job flags workspaces whose citation rate is falling.

### 11.6 Semantic graph queries

Agents, operators, and the in-app agent ask the graph questions in four ways. All four are governed agent tools. They are read-only and scoped to the caller's workspace and resource scope (§6.3: allowed labels, relationship types, and hop, node, and time budgets). They execute through the graph service on a read-only database role. They are recorded as frames and returned as context frames with citations. The same path therefore serves a wrapped agent, the in-app agent, and a person at the Ontology page.

1. **`get_ontology`**: how an agent learns the shape before it asks anything. It returns the active version's classes, properties, relation types, synonyms, and example questions as `graph` context frames. A planning model reads this the way it reads a database schema.
2. **`search_graph`**: the hybrid semantic retrieval of §11.5, with filters by label, property, time (`as_of`), and repository.
3. **`expand_graph`**: typed traversal from seed nodes (by id or from a search) along allowed relationship types, up to a hop budget. It returns a subgraph as `graph` frames whose `relations[]` carry the edges. This is how "everything connected to Customer X" and "what does this symbol call" are answered without generating a query.
4. **`query_graph`**: a natural-language question compiled to Cypher (the graph database's query language) and executed. The compiler is a `complex`-tier model call. It receives the active ontology version (classes, properties, relation types, and the synonyms the ontology engine collected), the workspace's query examples, and the question. What it produces is never trusted as written:
   - the Cypher is **parsed**. Only `MATCH`, `OPTIONAL MATCH`, `WHERE`, `WITH`, `RETURN`, `ORDER BY`, `SKIP`, `LIMIT`, `UNWIND`, and calls to an allowlist of read procedures are accepted. Any write clause, any schema clause, or any other procedure rejects the query before it runs.
   - the workspace predicate, the label and relationship allowlists from the caller's resource scope, and a `LIMIT` are **injected** by the graph service, never left to the model.
   - the plan is checked with `EXPLAIN` (which shows how the database would run the query without running it) against the node budget. A plan that scans beyond the budget is rejected with the reason.
   - it runs on a read-only role with the caller's time budget as the transaction timeout.
   - a syntax or plan rejection is fed back to the compiler at most twice, with the error, before the agent tool returns a typed failure.
   - the answer carries the executed Cypher, the ontology version, the nodes it cited as context frames, and a confidence that is the compiler's, labeled as such. The question, the Cypher, its digest, and the result digest are frames. Identical questions against the same ontology version are served from the recorded query.

Entity linking inside a question (matching a name to a node) uses the `light` tier and the entity index. Every linked node is cited in the answer, so a wrong link is visible. Questions are untrusted text. Nothing in them reaches Cypher except through the compiler. The compiler's output reaches the database only through the parser and the injector.

`as_of` applies to all four, using the node and edge temporal fields. So "what did we know about this account in June" is a query, not an export. Community summaries over graph neighborhoods (a GraphRAG-style layer of summarized clusters served as `doc` frames) are a v2 item. The four query kinds above are v1.

### 11.7 The data layer of the code graph: tables, queries, and storage objects

Code changes are only half of what an agent touches. The other half is the data behind the code. The code graph therefore carries a **data layer** built the same way the code layer is. Parsers run over the repository and resolve what they find into typed nodes, with provenance to the file and line that declared them. The layer is kept current on every push to the production branch and confirmed by what runs actually did.

**What is extracted, and from where.**

| Source in the repository | Parser | Nodes produced |
|---|---|---|
| SQL DDL (statements that define tables and schemas): migration folders (Atlas, Flyway, Liquibase, raw `.sql`), `schema.sql` dumps | tree-sitter SQL grammar for structure. A full SQL parser (dialect-aware: Postgres, MySQL, SQLite, T-SQL, BigQuery, Snowflake) for semantics | `Database`, `Schema`, `Table`, `Column`, `Index`, `Constraint`, `View`, and `Migration` nodes. A migration `DEFINES` or `ALTERS` the objects it touches, in order |
| ORM (a library that maps code classes to tables) and schema-as-code models: Drizzle, Prisma, SQLAlchemy, Alembic, Django, ActiveRecord `schema.rb`, TypeORM, Hibernate annotations, Ecto, GORM | per-framework tree-sitter queries over the host language | The same table and column nodes, `DECLARED_BY` the model class, with the framework recorded |
| Infrastructure as code (config files that declare cloud resources): Terraform, CloudFormation, CDK, Pulumi, SST, Kubernetes manifests, Docker Compose | HCL, YAML, and host-language parsers | `StorageBucket`, `Queue`, `Topic`, `Cache`, `Secret`, `DatabaseInstance` nodes with provider and region |
| Query sites in application code | tree-sitter queries that find SQL string literals, query-builder and ORM call chains, and storage SDK calls (S3, GCS, Azure Blob, SQS, Kafka, Redis clients) | `READS`, `WRITES`, `DELETES`, `MIGRATES` edges from the enclosing `Symbol` to the `Table`, `Column`, or storage object. Each carries `confidence` and `evidence` (file, line, the literal or call) |

Confidence is assigned by how the reference was resolved. `high` means a literal statement the SQL parser resolved to named tables and columns. `medium` means an ORM call resolved through a model declaration. `low` means a dynamically built query where only the table name is recoverable. `unresolved` means a query site was found but nothing could be named. Unresolved sites are still recorded, so coverage is reported as it is. Edges carry the operation (`select`, `insert`, `update`, `delete`, `ddl`) and, where resolvable, the columns.

**Runtime confirmation.** Frames confirm and extend the static picture. A tool call or command frame that executed a query, a storage SDK call captured as a `network` or `file_io` side effect, and connector sync runs against the live Postgres connector all produce `OBSERVED_ACCESS` edges from the run to the data object. A static edge that a run confirms is raised to `confirmed`. An observed access with no static edge is a finding (a dynamic query the parser missed) and a candidate ontology proposal.

**Live schema reconciliation.** Where the Postgres connector (§11.2) is connected to the database the code declares, the ontology engine links declared `Table` nodes to live tables by name. It then compares columns, types, and indexes. Drift is any gap between what the code declares and what the database has: code references a column the database does not have, a migration is not applied, or a table has nothing referencing it. Drift is reported on the Ontology page and offered to the findings job.

**What this buys the governor.** With this layer, the toolbelt policy (§6.12) can say what no static allowlist can. It can deny, or route to approval, any tool call whose resolved effect is a write to a table the customer has classed as sensitive (money, personal data, regulated), whichever code path performs it. It can require an approval when a change touches a symbol that writes a table in that class. It can show a CIO, per agent and per run, which tables and buckets the agent's work reached, with the evidence.

### 11.8 The ontology lives in git, and the schema registry is its loader

The current codebase already has a workspace schema registry. It holds an allow-listed vocabulary of labels and relationship types, immutable version snapshots, a pinned version per workspace, diffs, and validation that ingestion is grounded against. Its export layout was designed for git from the start. That code carries over. What changes is where the truth lives. The registry stops being a Postgres store. It becomes the loader, validator, differ, and pin logic over files in the main repo, the same rule as steering (§4.2).

The layout is the registry's own export layout, unchanged. There is one file per label and per relationship type, grouped by schema, with a manifest. It is JSON rather than TOML for three reasons. It is already built that way. Its diffs are already review-friendly. The read path needs no second parser. This is the one JSON directory under `.oxagen/`.

```
.oxagen/ontology/
  manifest.json                    # version, label, published_at, enforcement_mode, schemas[] (name, source, enabled)
  schemas/
    sales_crm/
      labels/
        Customer.json              # description, natural_key_props, properties[], synonyms[], sources[]
        Contract.json
      relationships/
        SIGNED_CONTRACT.json       # start_label, end_label, cardinality, description, properties[]
    github/                        # the built-in fragment, marked source = "builtin", never edited by hand
```

**A proposal is a pull request, and merge is activation** (§11.2). The engine's inferred changes, an edit on the Ontology page, and a hand edit all become a branch and a PR on the main repo. The PR gets the checks a Context PR gets plus the registry's own: schema validity, naming, no orphaned relation, no label removed while entities carry it without a migration plan, and a diff against the pinned version. The merged manifest freezes a new immutable version and moves the pin. The graph indexes the active version by digest and keeps every version for `as_of` queries. It holds each proposal's provenance (which source records and which profiler run inferred each class), and it holds all the entities. The Postgres `schema_registry.*` tables are gone. Enabled state and enforcement mode live in the manifest.

**Size, so nobody fears the repository.** An ontology is the schema, not the data. Entities (instances) never go to git. They belong to the graph, in the millions. Per workspace, an ontology is tens to a few hundred classes. Organization-wide, a Fortune 500 company's business ontology, all workspaces merged, lands in the range of a few hundred to about a thousand classes, a few thousand properties, and a few hundred to a couple of thousand relation types. That is one file per class and relation type, so low thousands of small files, which is a modest repository. Steering records are a separate count: hundreds to low thousands per workspace at maturity, again one file each.
## 12. Cost: accounted to the token, attributed to the operator, reconciled to the cent

### 12.1 What is being reconciled

Two different things are tracked, and they are kept apart on purpose:

- **Customer spend**: the money the customer pays to model and tool providers. Oxagen measures it per frame and adds it up into rollups (a rollup is a total built from smaller records). Oxagen then reconciles it against provider statements, meaning it checks that the two sets of numbers match. This is a FinOps feature (FinOps is the practice of tracking and managing cloud and AI spend). It is billed at zero (ADR-052).
- **Oxagen revenue**: priced by usage, per run. Every account includes the free tier. Starting is easy, and each run costs less as volume grows.

| | Price |
|---|---|
| Every month, every organization | first 1,000 runs free, every governance feature on |
| Runs 1,001 to 10,000 | $0.30 per run |
| Runs 10,001 to 100,000 | $0.20 per run |
| Above 100,000 | $0.12 per run |
| Evidence retention | 13 months included, then $0.10 per GB-month |
| Tokens Oxagen buys on the customer's behalf (`platform` funding source, §4.5) | at cost, no markup, capped per organization |
| Enterprise (annual) | committed use at 20 to 30 percent off the tiers, from $60,000 per year. Adds dedicated data plane or behind-the-firewall deployment, SSO and SCIM, the hosted witness runner, two-person mandates, support with an SLA, and invoicing |
| Onboarding discount | 20 percent off usage for 12 months when the customer converts to a paid plan within 7 days of the first run. Annual prepayment earns a further 20 percent |

  What counts as a run: a sealed run with at least one model call. Some runs are free: runs Oxagen halted before any model call, runs of the in-app agent, and witness runs. The customer never pays for Oxagen saying no, or for Oxagen proving work. Proven runs carry no surcharge. They are the asset. Every statement reports governed actions per run and retained gigabytes as secondary meters. These can be priced later without changing the model. Payment is by card, monthly, with no minimum below enterprise, and the customer can cancel any time. Stripe holds plans, customers, and invoices. Oxagen holds the meter. There are no credits, no resellers, and no revenue dashboard. The Spend page is for the customer's money.

  Why these numbers: the reference customer (50 agents, 5,000 runs a month) pays about $1,200 a month. That is roughly 5 to 10 percent of its token spend, an amount a team lead can approve without procurement. A large division at 50,000 runs a month pays about $10,000 a month, a normal governance line. Oxagen's direct cost per run (graph, storage, reflection, and amortized witness authoring on paid tiers) is one to four cents. Gross margin therefore stays above 80 percent at every tier. The free tier is the whole product, limited by volume and retention, never by features. Developers prove the value in pre-production, and upgrading becomes a volume decision. This replaces the governed-action meter of ADR-052 with the per-run model the positioning states. The governed-action count stays as a reported number.

> **Amendment 2026-09-13 (ADR-055).** The per-run model above, its price table and the "runs this period" meter are superseded. The billable unit is the governed action unit (GAU) of ADR-052, with its four exclusions, and the price is:
>
> - **A monthly bucket on the subscription.** The plan row (`billing.plans`) publishes `currency`, `rate_per_gau_micros`, `block_size_gau` and `included_gau_per_month`; a negotiated agreement is one `billing.contract_terms` row per organization with the same four figures. The effective terms are resolved on every read (`resolveContractTerms`), never copied into the organization. Every bucket is one month: for a subscriber, the anniversary-day slice of the current cycle (an annual subscriber gets a monthly allowance like everyone else); for an organization with no subscription, the UTC calendar month. `remaining = included + purchased + carried − used` and may be negative; purchased units carry into the next month, included ones do not.
> - **Unit-quantity purchases at the contracted rate.** More GAUs are bought in blocks of `block_size_gau` at `rate_per_gau_micros`, through Stripe Checkout, or by auto top-up (`auto_topup_blocks` blocks charged to the saved card when the bucket reaches `remaining ≤ 0`, at most one automatic attempt per exhaustion episode). Nothing sells dollars of usage.
> - **Two billing modes, decided by a platform operator** (`set_org_billing_terms`, no surface). *Prepaid* (the default): when auto top-up cannot run, the next governed action is refused (`gau_exhausted`). *Invoice billing* (`approved_for_invoice_billing`): consumption is never capped; overage is invoiced at the contracted rate at period end, or as an interim invoice for exactly `invoice_gau_max` GAUs (default 100,000) the day accrued uninvoiced overage reaches it, charged to the saved card that day or sent as a 30-day invoice when there is none; an unpaid invoice leaves the organization running and flagged past due, with no automatic suspension.
> - **One settlement ledger.** Every block purchase, auto top-up, interim and period-close charge is a Stripe Invoice recorded in `billing.gau_settlements` (`checkout` | `auto_topup` | `interim_invoice` | `period_close`; `pending` | `open` | `paid` | `failed`, with `paid` the only terminal state). Subscription dunning applies to subscription invoices only.
> - **The page prints the customer's contracted rate** with its source (published tier or negotiated agreement), the block price, the included GAUs per month, the bucket in GAU counts, and the invoices. Tokens are reported at zero and are not on the page; retention is not metered in rev1 and settles later as an invoice line at a contracted per-GB-month rate.
> - **The Free tier's included allowance replaces "first 1,000 runs free"; `create_org` grants nothing.** The published per-month figures, per-GAU rates and block size live in `docs/specs/governed-action-metering.md` §4.2.
>
> The customer-spend half of this section (accounting, attribution, reconciliation, billed at zero) is unchanged.

### 12.2 Price book

A price book is the table of prices Oxagen applies to each provider and model. `prices.price_books` and `prices.price_entries` hold: provider, model (canonical id and aliases), region, token class (`input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `thinking`, `web_search`, …), unit, **micro-USD per million units as an integer**, `effective_from`, `effective_to`, and source (provider list price, negotiated, customer override). A token class is one kind of token a provider charges for. Micro-USD are millionths of a dollar. Cache read tokens are prompt tokens served from a stored copy. Cache write tokens are prompt tokens saved for later reuse. Reasoning tokens (`thinking`) are tokens the model spends thinking before it answers. Organizations may override prices to record negotiated rates. Every cost record names the price entry id it used. A price correction therefore produces a recomputed record, never a silent change.

### 12.3 Cost record

Oxagen writes a cost record on every `model.response` frame (proxied) or `llm_call` frame (attested):

```json
{
  "usage": { "input": 1834, "output": 412, "cache_read": 12000, "cache_write_5m": 0 },
  "price_entry_ids": ["pe_…", "pe_…", "pe_…"],
  "cost_micros": 41265,
  "cost_basis": "gateway_observed" | "client_attested" | "estimated_unknown_model",
  "provider_request_id": "req_…",
  "provider_key_id": "pk_…"
}
```

Every amount is an integer in micro-USD. Per-frame cost is computed at full precision. Rounding to cents happens once, at the invoice or statement line, using half-even rounding (a value exactly halfway rounds to the nearest even cent). Tool calls with a declared price get the same record. Rollups (`cost.run_totals`, `cost.daily_totals` by agent, workspace, org, model, provider key) are derived indexes in Postgres. They are rebuilt from frames on demand.

### 12.4 Reconciliation

Reconciliation checks Oxagen's records against what providers report. The reconciler pulls provider usage exports (Anthropic, OpenAI, Bedrock, Vertex, and gateway providers) by provider key and day. It pulls provider invoices monthly. Matching runs at three levels, best first:

1. **By provider request id** to a single frame. The provider request id is the identifier a provider assigns to each request. Gateway-observed frames always have one.
2. **By key, model, day, and token class totals** to the ledger's rollup.
3. **By invoice line** to the monthly rollup.

Variance is recorded per key-day and per invoice line in `cost.reconciliations` with `matched_micros`, `provider_micros`, `variance_micros`, and a status. Any variance above one cent per key-day opens an exception. The exception attaches the unmatched frames or the unmatched provider lines. The Spend page reports two targets: the share of provider spend matched to a frame, by month, and the open variance in dollars. Client-attested frames without a provider request id match only at level 2 and are labeled as such.

### 12.5 Budgets

Budgets live in `billing.spend_budgets`. Each budget belongs to an organization, workspace, operator, or agent, and has a period and a hard or soft mode. Hard budgets are enforced at the model proxy before the call. The proxy checks a running counter per budget in Postgres, which the recorder updates. Hard budgets are also enforced in the policy bundle for harness-tier runs. A breach is a `policy.decision` frame and, by policy, a pause.

### 12.6 Token accounting on every model call

Providers name token classes differently. The cost record normalizes them once, at the model proxy or the collector, into a fixed set. Every downstream number derives from these fields and nothing else:

| Field | Meaning | Anthropic | OpenAI | Gemini | OpenRouter |
|---|---|---|---|---|---|
| `input_uncached` | prompt tokens processed fresh | `input_tokens` | `prompt_tokens − cached_tokens` | `promptTokenCount − cachedContentTokenCount` | native usage passed through |
| `cache_read` | prompt tokens served from cache | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `cachedContentTokenCount` | native |
| `cache_write_5m`, `cache_write_1h` | prompt tokens written to cache, by TTL | `cache_creation.ephemeral_5m/1h_input_tokens` | n/a (implicit) | explicit cache create calls | native |
| `output` | completion tokens excluding reasoning | `output_tokens` | `completion_tokens − reasoning_tokens` | `candidatesTokenCount` | native |
| `reasoning` | thinking or reasoning tokens | `thinking` blocks (counted in output, split when reported) | `completion_tokens_details.reasoning_tokens` | `thoughtsTokenCount` | native |
| `server_tool_requests` | provider-side tool uses priced per request | `server_tool_use.web_search_requests` | built-in tool calls | grounding requests | native |
| `tool_definition_tokens` | tokens spent on the tool list in the prompt | measured by Oxagen from the request | same | same | same |
| `context_frame_tokens` | tokens of context frames Oxagen injected, by protocol accounting | measured | same | same | same |
| `steering_tokens` | tokens of injected steering | measured | same | same | same |

Every field is an integer. Absent classes are zero, never null. When a provider reports a class Oxagen does not know, the record stores it under `unmapped` with the raw name. That class is priced at zero with `cost_basis: estimated_unknown_class`, so the gap stays visible. From these fields, each model call carries the derived metrics customers actually look at:

- **Cache hit rate** `= cache_read / (input_uncached + cache_read)`.
- **Cache write cost share** `= cost(cache_write) / cost(model call)`. This is high when a prefix is written and never read again.
- **Effective input price** `= cost(all input classes) / (input_uncached + cache_read)`, per million.
- **Prompt composition**: the shares of the prompt spent on tool definitions, context frames, steering, and conversation, from the measured fields.
- **Latency**: time to first token, total duration, retries, and the provider error that caused each retry.
- **Provider request id and concrete model id**, for reconciliation (§12.4).

Client-attested model calls (harness telemetry rather than the proxy) carry the same fields where the harness reports them. The fields the harness does not report are marked as gaps. A cache hit rate over a mixed fleet is therefore never computed from missing data as if it were zero.

### 12.7 Attribution: from a frame to the operator

Every cost record hangs on a frame. Every frame knows its step, turn, run, agent, operator, workspace, and organization. Attribution is therefore a rollup along the hierarchy in §3. Every level adds these keys: model, provider, provider key, funding source, tool (for tool calls), repository, and task reference.

| Level | What is reported | Materialized in |
|---|---|---|
| Model call | usage by class, cost, cache metrics, latency, retries | the frame |
| Tool call | validation result, duration, declared price, side-effect class, approval | the frame |
| Step | one of the above | derived |
| Turn | steps, spend, tokens by class, cache hit rate, prompt composition, outcome of the turn | `cost.turn_totals` |
| Run | turns, spend, tokens, cache hit rate, tool calls by result, proof, productive ratio, enforcement tier, replay grade | `cost.run_totals` |
| Agent | runs, spend, proven spend, productive ratio, spend per proven run, trend | `cost.daily_totals` by agent |
| Operator | agents, runs, spend, proven spend, productive ratio, budget position | `cost.daily_totals` by operator |
| Workspace and organization | the same, plus by model, provider key, repository, task | `cost.daily_totals` |

Rollups are derived indexes rebuilt from frames. The frame is the record. An operator's number is the sum of their agents' runs. An agent's number is the sum of its runs. Nothing is attributed to a level that a frame cannot reach. When a run has no operator recorded (a client-attested run that arrived without one), it is attributed to the agent's owning operator and flagged. It is never dropped or spread.

### 12.8 Value: how much of the money turned into progress

Customers pay for tokens. They want to know what the tokens bought. Oxagen answers with three measures per run, rolled up along the same hierarchy. All three are computed from frames, and none from a model's opinion of itself:

1. **Proven spend.** Spend on runs whose witness verdict is `flipped` (§8.5). Runs whose outcome a human verified without a witness (an approval, a merged PR, a closed task) are reported separately as *accepted*. They are never folded into proven. Everything else is unproven spend, split into *completed but unverified*, *cancelled or halted*, and *failed*.
2. **Productive ratio.** Per run, the share of steps that advanced the task. Where the run came through Stella, Stella's step-grading ladder grades the steps. Elsewhere a deterministic rubric grades them: a tool call that produced a side effect the run kept, a model call whose output led to a kept side effect, or a read whose result was later cited. Repeated identical tool calls, calls denied by policy, retries after provider errors, and steps after a halt are unproductive by definition. This measure is carried from the wrapper design corpus, where it is already specified.
3. **Spend per proven run** and its trend, per agent and per operator. A team can see whether an agent is getting cheaper at producing verified work.

**Where to optimize.** The **findings** job is the reconciler's sibling. Findings are specific, costed problems an operator can act on. The job runs after each seal and writes `cost.findings` rows. Each row carries the frames that prove it and the money at stake:

| Finding | Detected from | What it tells the operator |
|---|---|---|
| Cache misses after a stable prefix changed | system-context digest differs between consecutive turns while conversation prefix is unchanged | which configuration change (steering publish, tool list change, model switch) invalidated the cache, and its cost |
| Cache writes never read | `cache_write` > 0 on a run's last turn, or a write with no later read in the TTL | shorten the prefix, or stop writing cache for one-turn runs |
| Tool-list bloat | `tool_definition_tokens` above the workspace median for the agent's grants | narrow the agent's grants, listing the exact tools never called in the last N runs |
| Context bloat | `context_frame_tokens` above budget norm with low citation rate (from `context_use_feedback`) | lower the context budget or tighten the retrieval kinds |
| Retry storms | consecutive provider errors with retries in one turn | provider or key health, and the cost of the retries |
| Duplicate tool calls | same tool version and input digest twice in a run | a steering record candidate ("do not re-read X"), opened as a proposal |
| Unproductive tail | steps after the last productive step exceed a threshold | budget or stop rules for the agent |
| Wrong tier | a run whose steps were all classification-shaped on a flagship model, or a proven run on a light model at high retry | model routing per agent |
| Budget headroom | an operator or agent consistently below or above budget | resize the budget |

Each finding names the level it applies to (run, agent, operator, workspace) and the estimated saving in micro-USD from the frames it cites. Findings are ranked by money at stake, and the Spend page leads with them.

### 12.9 Reports and statements

- **Operator view.** For one operator: their agents, runs, spend by model and provider, proven spend, productive ratio, budget position, and their findings. This is the report a team lead reads.
- **Agent view.** For one agent across operators: the same, plus spend per proven run over time and the tool-call mix.
- **Run waterfall.** For one run: turns as bars, steps inside them, cost accumulating left to right, cache hit rate per turn, the proof frame marked, and findings pinned to the frames that caused them.
- **Monthly statement** per workspace and organization: spend by operator, agent, model, provider key, and task. Proven versus unproven. Reconciliation status against provider invoices (§12.4). Exported as CSV and as a signed PDF.
- **API and MCP** expose the same rollups, so a customer can pull attribution into their own FinOps tooling. Every number carries its basis (`gateway_observed`, `client_attested`, `estimated`).

---

## 13. Audit, retention, and the fidelity call

### 13.1 The call

**Keep everything, at full fidelity, for seven years, and make it cheap by writing it once.**

- Every frame's body (prompts, completions, tool input and output, steering, context frames) is retained as an encrypted, content-addressed object from the moment it is recorded. The retention clock runs seven years from the seal by default. Organizations may set a longer period.
- `digest_only` mode is an opt-down per workspace for customers who cannot store prompt content. The system records it as a completeness gap, and it lowers the replay grade. It is not the default. Replay without bodies grades `inspect`, not `view` (§8.4). That grade gives a chain that can be audited, not a run that can be read. The product's explanation promise depends on bodies.
- The run ledger is retained forever. It holds the run, attempt, seal, attestation (a signed statement that vouches for a seal), and frame metadata with digests and costs.

Seven years is a customer procurement requirement more than a requirement of SOC 2, a security audit standard. SOC 2 itself does not fix a number. The current codebase claims seven years for a Postgres security-event table, while the trace tables expire in a year or less. This spec removes that contradiction with one policy applied to the whole run record.

### 13.2 Cost of the call

Order-of-magnitude figures for the deck's reference customer (fifty agents, five runs per agent per day):

| Quantity | Value |
|---|---|
| Runs per month | 5,000 |
| Frames per run (typical) | 100 to 400 |
| Body bytes per run, compressed | 0.3 to 1 MB |
| Archive growth per month | 1.5 to 5 GB |
| Seven-year archive | 130 to 420 GB |
| Cold storage at roughly a tenth of a cent per GB-month | under $1 per month |
| Frame nodes in the graph over the thirteen-month hot window (the period frames stay in the graph) | 6 to 25 million |

The graph, not the archive, is the cost that needs a window. That is why frame nodes are compacted (§13.3), meaning removed from the graph once the segment holds them. Bodies are never moved.

### 13.3 Tiers

| Tier | Where | What | Retention |
|---|---|---|---|
| Ledger | Neo4j (+ Postgres rollups) | `:Run`, `:Attempt`, `:Seal`, attestation, counts, cost, tier, gaps | forever |
| Frames | Neo4j | `:Frame` nodes with digests, cost, policy decisions | hot window, default 13 months, then compacted into the segment |
| Bodies and segments | Object storage, write-once (data cannot be changed once written) | encrypted bodies and a per-seal archive segment: frame envelopes as NDJSON, a Merkle root (one hash that covers every frame), and an attestation | 7 years default, unless a legal hold (a block on deletion for a legal matter) overrides it |
| Control-plane audit | Postgres | admin actions, IAM changes, repo bindings, plane changes, key rotations | 7 years |

The archive segment is written **at seal time**. It is never a later copy of the graph. It is the same bytes the graph indexed, written once. Compaction removes frame nodes and leaves the run node with `frame_count`, `merkle_root`, `segment_ref`, and the rollups. Render replay of a compacted run reads the segment.

### 13.4 Object storage and holds

Each data plane gets its own buckets with object lock, a storage setting that blocks deletion. The lock runs in compliance mode, so no one, not even an admin, can lift it early. Retention is set per object from the organization's policy. Each organization has its own key-encryption key, and each object has its own data key. Legal holds are records in Postgres. They pin retention and block erasure for named runs, agents, or a whole workspace. Exports produce a verifiable bundle: segments, attestations, key ids, and a verifier script.

### 13.5 Erasure

GDPR (the EU privacy law) erasure works by **crypto-shredding**, which destroys the encryption key so the data can never be read again. Bodies attributable to a natural person are encrypted under a per-subject data key. Erasure destroys the key and writes a tombstone frame in the ledger with the digests that remain. The chain stays intact and verifiable. The content is unrecoverable. Redaction detectors run before write, so most personal data never enters a body in the first place. The erasure SOP carries over.

---

## 14. Mission Control

Mission Control has eleven pages: eight at workspace scope and three at organization scope, Skills having joined them with ADR-090. `apps/app/ARCHITECTURE.md` sets the shipping page set and wins where it and this section differ — it records that this count and Appendix F have drifted in other directions too (Ontology cut, Audit rescoped), and reconciling those is not ADR-090's job. Appendix F maps every current route onto these ten. Approvals are not a page of their own. They appear as a panel on Fleet and as a strip on Run, because an approval is always about a run.

| Screen | Job | Primary actions |
|---|---|---|
| **Fleet** | Every run, live and recent, with its enforcement tier, replay grade, cost so far, and pending approvals | pause, resume, cancel, open |
| **Run** | A frame-by-frame player for one run. It shows the transcript at three zoom levels (turns, steps, everything) under a transport, the playback controls (scrub, step, play, pause, ×1 to ×4). It also shows what the agent was told, each model exchange, tool calls with their validation results, policy decisions, proof, a cost strip, and chain status | steer (with a delivery mode), pause, cancel, approve, fork replay, bisect, export |
| *(panel on Fleet and Run)* **Approvals** | The queue. Each item shows its four-hop chain, the four links behind a request (who asked, which agent, which action, which rule) | approve, deny, add reason |
| **Agents** | Each agent's identity, run credential, roles, its toolbelt (the tools it may call, with schemas and per-tool decision rules), the mandates it holds, budgets, enrollment status, and tamper incidents | register, enroll, revoke, grant, set budget, request mandate |
| **Tools** | The registry (servers, tools, versions, schemas, safety classification), approval rules and auto-approval conditions, connections and their owners, credential grants, the mandates ledger, policy versions with their tests and simulation, kill switches, and the last result from the assurance suite | import server, approve observed schema, add connection, grant mandate, edit and simulate policy, flip a switch |
| **Ontology** | The workspace's model of its own business, and the page the product is known for. Tabs in order: **Model** (the live map: every class with its entity count, freshness, sources, and relations drawn, plus the consequence on hover: most cited by agents, rules that reference it, proven runs per class, drift found), **Graph** (explore instances, typed expansion, ask in plain English and see the Cypher graph query and the citations behind the answer), **Sources** (connectors, sync health, entity provenance), **Repositories** (main repo and linked repos, production branch, last indexed commit, event health, issue import, code graph, data-layer drift), **Versions** (the git history of `.oxagen/ontology/`, open proposals as pull requests with diffs, an `as_of` picker). The page also lists embedding indexes with their recall and citation rate | ask the graph, open an ontology proposal, link repo, set production branch, sync now, add source, resolve entity, upgrade an embedding index |
| **Skills** | Which skills the workspace's `.oxagen/skills.toml` lets an agent find, which it may load, what that cost, and what was held back and why. Tabs: **Catalog**, **Search** (the `search_skills` console), **In the loop** (the interjection seat), **Reflection** (research-only, quarantined) and **Versions** (the config's git history, each version a pull request). Oxagen resolves; the harness runs. (ADR-090) | turn on, edit the config, approve a digest, add a skill — each a pull request |
| **Steering** | Published records, proposals, open Context PRs, effect metrics, and retirement candidates | open Context PR, review, retire |
| **Spend** | Findings ranked by the money at stake. Cost by operator, agent, model, provider key, and task. Proven spend versus unproven spend, and the productive ratio. Cache hit rate. Reconciliation status and variance. Budgets | act on a finding, set budget, open exception, export statement |
| *(org)* **Organization** | People, roles, invitations, SSO (single sign-on), workspaces, model funding and routes, the data plane, and API keys | invite, change role, create workspace, set funding, set route |
| *(org)* **Billing** | Governed-action usage, the retention meter, plan, and invoices | change plan |
| *(org)* **Audit** | Control-plane audit events, data plane, key rotation, legal holds, and exports | export, hold, rotate |

Interaction rules: every badge that describes trust (enforcement tier, replay grade, attestation, cost basis) shows the recorded value and nothing stronger. Every number that is money shows its basis. Every explanation is a chain of links to frames, records, and commits, not a summary.

### 14.1 Surfaces

One agent tool contract drives all four surfaces: the API, MCP (Model Context Protocol, the standard way agents connect to tools), the CLI (the command-line tool), and the UI. The manifest gate that exists today checks that the four stay in parity. The CLI is thin: `oxagen login`, `oxagen agent enroll|status|unenroll`, `oxagen agent register`, `oxagen run list|show|export`, and `oxagen context propose` (which delegates to Stella when Stella is present). The in-app agent (§4.4) sits on every screen as a side panel. It onboards a new organization, changes configuration through the same contracts the screens use, and explains runs and spend. Each of its turns is a run of its own, recorded and metered like any other agent's run.

---

## 15. Non-functional requirements

| Area | Requirement |
|---|---|
| Gateway latency | The model proxy adds ≤ 30 ms at p50 (the typical request) and ≤ 100 ms at p99 (the slowest 1 in 100 requests) before the first byte. Streaming passes straight through. Tool gateway validation takes ≤ 20 ms at p99 for schemas under 64 KB |
| Fail behavior | Enforcement seams fail **closed**, meaning a missing policy blocks the call. Telemetry seams fail **open**, meaning the call proceeds and the gap is recorded. Recorder backpressure never blocks an agent. The recorder spools instead |
| Availability | Gateway and control channel: 99.9%. Mission Control: 99.5%. The recorder delivers at-least-once (a frame may arrive more than once but is not dropped), with idempotent frame ids so a repeat is stored only once |
| Throughput | 2,000 frames per second per organization, sustained, on the shared plane. Graph writes are batched |
| Isolation | Neither store can express a query that crosses organizations. A nightly cross-tenant probe on both stores verifies this |
| Security | All credentials are hashed or KMS-enveloped (encrypted under a key management service key). Run tokens last ≤ 15 min. Bundle and attestation keys rotate with published validity windows. Secret scanning runs on tool arguments and record bodies |
| Compliance | SOC 2 Type II controls map to the audit tiers. Data residency is set per data plane. Erasure works by crypto-shredding (destroying the key so the data can no longer be read) |
| Conformance | Provider conformance and lifecycle fixtures (shared test cases that check an implementation follows the protocol) from the protocol repo run in CI, pinned by commit |
| Currency | Every price entry and cost record carries its currency. The value of record is the provider's billing currency. Conversions use a dated rate table (`cost.fx_rates`), at the frame's time for display and at the statement's time for reconciliation. Every converted number carries its rate and source. An organization has a display currency and a billing currency, chosen from the set Stripe supports. Mandates are compared in their own currency. Reconciliation matches in the provider's currency and reports variance in both. The wedge is USD only. The model is built in from the first release |
| Language | No prose is hard-coded. Every string the interface shows lives in a message catalog keyed by a stable message id, in ICU MessageFormat (a standard format for translatable strings with plurals and variables). There is one catalog per locale, with English as the source. Locale is negotiated per person, profile first, then browser. Dates, numbers, currencies, and units format by locale. Layout supports right-to-left (scripts that read from right to left) from the first release. Prose the models generate (findings, explanations, rationales, assistant replies) is generated in the operator's locale and recorded on the frame. Steering records keep their language with a tag. Machine-readable fields in records, receipts, and exports are never translated. The wedge is English only. The first additional locales land in Series A |
| Deployment | The same containers run in Oxagen's cloud and behind a customer's firewall (§4.6). There is no fork |

---

## 16. Carry over, leave behind

This table lists what carries over from the current `oxagen` repository (and its `oxagen-platform` ancestor) and what stays behind:

| Carry over (design and often code) | Leave behind |
|---|---|
| The kernel (the core that runs every call) and its `invoke()` pipeline, the registry, verb-first naming, and the manifest and parity gates. One rename: contracts and agent tools are both called agent tools now | 229 contracts. 78 agent tools in the wedge and 96 for the full product, listed in Appendix E |
| Tenancy seams (`runInTenantScope`, `withTenantDb`), the RLS manifest generator (RLS is row-level security, Postgres rules that hide one tenant's rows from another), and the startup guards | `app.rls_bypass`, six policy classes, and nullable-workspace tables |
| The organization and workspace model, immutable namespaces, and the Better Auth binding | About 110 tables across 20 schemas. 35 tables in 9 schemas remain, listed with their columns in Appendix A |
| IAM principals (IAM is identity and access management, the rules for who may do what), the delegation ceiling, resource-scope ceilings, and the three live resolver rules | Dead condition language, and the enterprise-tier "allow everything" bypass |
| The wrapper (today's tacho package) and its parts: enrollment, device keys, the collector, hooks, the policy bundle, commands, approval tokens, incident kinds, and the event vocabulary | ClickHouse `tacho_events`, and all of ClickHouse |
| The run ledger invariants, the rules that must always hold: dense seq, digest chain, seal fence, and one-shot finalization | Postgres as the run store. The store is the graph plus segments |
| The run-evidence protocol consumer, pinned fixtures, and SDK types with a Zod drift check | Vendored protocol drafts |
| The two-axis memory concepts: confidence versus enforcement, decay, and citation pressure | The `engram` package, the `rules` engine, and the `:AgentMemory` label. Records replace them |
| The workspace schema registry's code: validation, immutable versions, pin, diff, the ingestion grounding seam, and its export layout. It now reads `.oxagen/ontology/` in the main repo (§11.8) | The `schema_registry.*` Postgres tables, and activation by API. A merge activates instead |
| Connector dual-write (each change is written to both the old store and the new one), the GitHub App, and ingestion validation | The Slack, Google, Microsoft, Salesforce, and Stripe connectors (v2 via SDK) |
| The crypto envelope (envelope encryption: a data key encrypts the content, and a master key encrypts that data key), the storage adapter, and notifications | The `content`, `cms`, `chat`, `workflow`, `eval`, `environments`, `plugin`, and `mcp` registry tables |
| Nothing from billing. Billing is rebuilt small (§12.1): Stripe for plans and invoices, one usage meter per run, and budgets | The entire billing package: credits, the metering gate, the rate card (the price list for each unit of usage), the governed-action meter, reseller tables, Stripe sync jobs, and spend dashboards as a revenue line |
| Data planes (ADR-042) | Per-store singletons |
| The in-app agent design (ADR-053). Stella runs as its own service, and Oxagen talks to it over HTTP. The engine asks Oxagen for every model call and tool call. Each organization has one model funding source | Running any agent loop inside Oxagen's own process, and the older plan of packaging the Rust engine as a helper container that Oxagen starts and supervises. Over HTTP is the design. Those two were the alternatives it replaced |
| The web-app 2.0 information architecture (workspace, org, and account scopes) | 70 page files. Ten pages remain, mapped in Appendix F |

The target Postgres schemas are `auth`, `org`, `wrk`, `iam`, `tools`, `prices`, `cost`, `billing`, and `control` (commands, approvals, archive manifests, and audit). Everything else lives in the graph or is gone.

---
## 17. Delivery plan

Each milestone has an acceptance test that a customer could run.

| Milestone | Delivers | Accepted when |
|---|---|---|
| **M0 Foundations** (weeks 1–4) | The repo, the kernel, tenancy, RLS (row-level security) with role-based system access, org and workspace creation including a Neo4j database and repo binding, IAM, and the tool registry. | A cross-tenant probe (a test that tries to reach one tenant's data from another tenant) finds nothing in either store. A workspace cannot be created without a main repo. A second repo can be linked and unlinked. |
| **M1 Gateway** (weeks 3–8) | The model proxy. The tool gateway with schema validation (each tool call is checked against the tool's declared input shape before it runs). Run tokens (credentials tied to a single run). Frames, chain, seal, and attestation. The Fleet and Run pages with render replay. The model layer with OpenRouter routes and funding sources. The Stella engine container and the in-app agent's onboarding flow. | The gateway wraps Stella and Claude Code. A run can be halted mid-loop from the UI. An exported run can be verified offline. The in-app agent onboards a new organization end to end, and its turns replay as runs. |
| **M2 Control** (weeks 7–11) | Bundles, commands, approvals with tokens, and budgets. The full call pipeline with taint and receipts. The credential broker with at least token exchange and restricted keys. Mandates and the ledger. Kill switches. Cedar policy with tests and simulation. The Tools page. Cost records with normalized token classes, the price book, and rollups to operator level. The findings job and the Spend page. | The adversarial suite (§6.13) passes every case against the live gateway. A consequential call that exceeds its mandate is denied, and the ledger does not change. An auto-approval fires only inside its conditions. A `require_approval` tool call parks, is approved from Slack, and is billed to the cent. A budget breach pauses a run. An operator's statement sums exactly to their agents' runs. |
| **M3 Teach** (weeks 10–15) | The records endpoint, the reflector, the promoter, Context PRs through the GitHub App, steering delivery, and effect metrics. | An agent learns something. The lesson becomes a Context PR. Merging it changes the next run's context, and the frame shows the change. |
| **M4 Ground** (weeks 13–18) | The ontology engine and three connectors. GitHub events and issue import. The code graph with webhook-driven incremental updates and manual sync. Voyage embeddings with hybrid retrieval and reranking. The three graph query agent tools with the Cypher parser and injector. Entity provenance. Oxagen as a protocol provider that passes conformance. | A customer's Linear and GitHub data produce an ontology proposal. Activating it yields cited context frames in a run. A push to the production branch updates the code graph within a minute, and a push to another branch does not. A missed webhook is repaired from the next push's previous-head. A natural-language question returns cited nodes with its Cypher shown. A question that would write or scan past budget is rejected before it runs. |
| **M5 Audit** (weeks 16–20) | The archiver, compaction, holds, erasure, and reconciliation against a real provider invoice. | The provider invoice matches above 99.9% by frame. Erasure leaves a verifiable chain. |
| **M6 Prove** (weeks 18–24) | The witness runner. The witness author, with the test-flip and build oracles first. The airlock at `L0`. Tamper exclusion, proof stamping, and proven spend in the Spend page. | A witness the agent never saw proves a PR opened by a wrapped agent. The agent's frames contain only pass or fail. A PR that edits the test harness is recorded as tampered. The proof verifies offline. |

### 17.1 Three phases

The milestones above are the build order. The phases below are the business order. Each phase has a trigger that ends it, and the phases match the positioning deck.

| Phase | What ships | Trigger to leave |
|---|---|---|
| **The wedge** | Tenancy and identity. The gateway (the model proxy, the tool gateway, wrapping for Stella, Claude Code, Codex, and SDK agents, and one-click installers on three platforms). The toolbelt with approvals, mandates, and kill switches. Runs and frames with render replay. Main and linked repos. Records, Context PRs, and agent definitions in git. Spend accounted to the operator, with findings. The GitHub link with issues and the code graph. Voyage embeddings, search, and graph questions. The Ontology page. Proof ingested from Stella's own ladder. The free tier and gated onboarding. Milestones M0 to M3 and the coding-team half of M4. | Customer 1 in production and paying. Five paying accounts opens the seed round. |
| **Series A** | What a Fortune 500 security review asks for and what the seed funds. The hosted witness runner with several oracles, so any agent's work is proven (M6). The audit tiers with archive, holds, and erasure, plus provider reconciliation (M5). Dedicated data planes and running behind the firewall (§4.6). SSO and SCIM (single sign-on, plus automatic user provisioning from the customer's identity provider). Two-person mandates and the published assurance suite. The data layer of the code graph, the Linear and Postgres connectors, and the full ontology engine. Outbound events (§7.7) and agent messaging (§7.6). Fork replay and bisect. Multicurrency and the first non-English locales (§15). SOC 2 Type II (an independent audit of security controls over a period of months). Owned intelligence v1: training-set export, the training pipeline, the evaluation harness (the test set that scores a trained model), and hosted serving. | Thirty-five owned models sold. |
| **Dominate** | The in-firewall installer for owned models. Sovereign and regional planes. Community summaries over the graph. A public registry of conformant providers and tool servers. Agent definitions and policy packs shared across organizations and by industry. Federation between organizations. The connector ecosystem through the SDK. Further locales. | None. Growth. |

The wedge ends when Customer 1 is in production, not on a date. M6 produces the labeled runs that the Series A training pipeline consumes.

---

## 18. Risks and open decisions

| Item | Position | What would change it |
|---|---|---|
| Neo4j databases per instance | Verified. Aura allows 5 databases per GB of RAM, with a ceiling of 100 per Aura instance. The setting is enabled only at creation and is in public preview (open for use, but not yet final). Sharding, which spreads organizations across instances, starts at 25 paid organizations per 32 GB instance. Free organizations are pooled (§5.3) | If Aura's preview slips or the ceiling drops, the fallback is self-managed Enterprise on Kubernetes with `dbms.max_databases`. The data plane table can point any organization at either option |
| Graph write throughput for frames | Batched writes, a hot window, then compaction | If a customer exceeds 2,000 frames/s, add a per-org ingest partition. Never add a second store of truth |
| Claude Code model calls | Setting the base URL to the proxy earns the `gateway` tier for model calls | If a harness cannot point at the proxy, the run gets the `harness` tier and the record says so |
| Ontology in git | Graph-only in v1 | Regulated customers may ask for ontology changes as Context PRs. The proposal object already has a diff |
| Approval tokens | Biscuit v2 as designed (a Biscuit token is a signed token that its holder can narrow without asking the issuer again) | If SDK support in Python or Go lags, fall back to a signed JWT (JSON Web Token) with the same claims |
| Steering format | `.oxagen/rules`, in the context-record TOML format that Stella implements. Stella symlinks to it | The directory name is fixed. If a second agent needs its own path, it gets a symlink the same way Stella does |
| Protocol trace journal | Export a `contextgraph-trace` journal per run and pass its oracles | The journal is a sketch (`0.1`). Pin its fixtures by commit, like the frame fixtures |
| Rolling model aliases | Tiers point at `z-ai/glm-latest` and `z-ai/glm-flash-latest`. Frames record the concrete model, meaning the exact model id behind the alias | If an alias flips to a model with a different price or behavior mid-month, the reconciler flags it by concrete id. An organization can pin a model |
| Engine availability | `stella serve` is a required service for the in-app agent only | The gateway, recording, and every screen work with the engine down. Only the assistant panel reports the outage |
| Billable unit | Per run, with a plan allowance. Governed actions and retention are reported as secondary meters | ADR-052 chose the governed action because runs vary a hundredfold in size. If small runs subsidize large runs in practice, price the governed action meter, which is already reported |
| Witness disclosure grain | `L0` (pass or fail only) by default. The disclosure grain is how much detail a witness reveals about a proof. Stella's own default is `L3` for convergence speed | If `L0` measurably slows convergence for a customer, the workspace can raise the grain as a recorded policy decision. The record keeps the grain per proof, so a training set can be filtered by it |
| Witness runner isolation | A separate execution plane (the witness runs on its own infrastructure), separate credentials, and no path from the worker's run | Any probe from a worker toward witness storage is a denied tool call and an incident. The proof frame carries the runner's attestation, so isolation is verifiable, not asserted |
| Behind the firewall | Same containers, a deployment mode flag, air-gapped supported (§4.6), Series A | If a customer needs it in the wedge, the single-node Compose variant is the early path. The Helm chart follows |
| Agent messaging | Agent-to-agent messages are evidence, not instructions. Taint applies (§7.6), so their content is marked untrusted | If customers need agent messages to carry authority, that is a grant on a named sender, never a default |

---
## 19. Demo Wow! Scenarios

Status: `complete` through W12 (2026-09-12, coverage audit, prompt W12). W13 was adopted on 2026-09-18 by ADR-090, which puts skills resolution in scope; its page coverage is listed below with the rest.

Each scenario is one moment an investor or a customer should remember. The mockups are the app, screen for screen, in the house brand. The prompts that produce them are in `2026-09-11-oxagen-demo-mockup-prompts.md`, beside this document; each prompt publishes its mockup and fills in its row and its page-coverage cells below.

| Id | Wow moment | Pages covered | Mockup | Status |
|---|---|---|---|---|
| W1 | Sixty seconds to governed: sign up, wrap Claude Code with one click, first run on Fleet | sign-in flows, onboarding gate, installer, Fleet (first run), discount offer | [W1 mockup](https://claude.ai/code/artifact/31579436-1abf-48f8-b320-8740c4029b0f) | mocked |
| W2 | Stop it. Steer it.: watch fifty agents, pause one, steer it, see the frame that received it; mass steer with @agents | Fleet, Run (live), messages | [W2 mockup](https://claude.ai/code/artifact/0b3eae2f-4fd9-45a5-b667-e04367999d1d) | mocked |
| W3 | Money asked, a human answered: a mandate-bound payment parks, is approved with the full chain, and the receipt shows the one-call credential | Approvals panel, Run strip, Agents (mandate), Tools (mandates ledger), receipt | [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce) | mocked |
| W4 | The flight recorder: a sealed run replayed frame by frame with cost, fork, bisect, export | Run (sealed, compacted) | [W4 mockup](https://claude.ai/code/artifact/a4b69d0b-715c-434c-9f4e-80534bf2e462) | mocked |
| W5 | Proven, not claimed: the witness flipped on main and the PR; the agent saw only "pass" | Run (proof), witness run, Tools (assurance), Spend (proven) | [W5 mockup](https://claude.ai/code/artifact/81725124-b936-4cbb-9e40-79089b5a1e35) | mocked |
| W6 | It learned, you approved, it changed: record to proposal to Context PR to merge to the next run | Steering, Run, Agents (definition in git) | [W6 mockup](https://claude.ai/code/artifact/2bbadccb-92ff-4ade-8f6d-704d9c66dafe) | mocked |
| W7 | The shape of your business: the Ontology map, ask in plain English, Cypher shown, versions in git | Ontology (Model, Graph, Sources, Repositories, Versions) | [W7 mockup](https://claude.ai/code/artifact/8692f683-0eab-4a1f-ad66-20f4a1a2db5b) | mocked |
| W8 | Every dollar, every operator: proven spend, findings ranked by money, reconciled to the cent | Spend, Billing | [W8 mockup](https://claude.ai/code/artifact/6a15975f-6719-4b4c-aae5-4b942dea0bb1) | mocked |
| W9 | The toolbelt, governed: only granted tools visible, no credentials held, policy simulated on real history | Agents, Tools | [W9 mockup](https://claude.ai/code/artifact/c16a2951-1a79-4c70-b202-ec405c0563dc) | mocked |
| W10 | The CIO's console: who can do what, where data lives, what happened, what can be proven, behind the firewall | Organization, Audit | [The CIO's console](https://claude.ai/code/artifact/403166f6-9216-4d23-86ac-bb3c2aa60b23) | mocked |
| W11 | Configuration is a conversation: the assistant acts through the same governed actions, with receipts | Assistant panel (all pages), Account dialog, notifications, command menu | [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b) | mocked |
| W12 | Coverage audit: every page and state mocked | all | [W12 audit](https://claude.ai/code/artifact/45c5e3f9-82f0-404e-ad69-b3279d84c649), [The Ten Pages](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) | mocked |
| W13 | In the loop: the skills scenario — skills off by default, resolution as config not model, and a run interjected before the first model call | Skills (Catalog, Search, In the loop, Reflection, Versions), skills-off gate, Run (interjected), Fleet (interjection banner) | [W13 scenario](https://github.com/macanderson/tmp-oxagen-mockups/blob/main/docs/w13-in-the-loop-scenario.md) | mocked; **adopted** — ADR-090 puts skills resolution in scope and the #3098 lane builds it |

**Page coverage.** Every row must carry at least one link before the section is complete.

| Page, panel, dialog, or flow | Route | States required | Mockup |
|---|---|---|---|
| Sign up, verify, log in, two-factor, forgot and reset, accept invite, create organization | `(auth)/*`, `(onboarding)/new-organization` | loaded, error, phone | [W1 mockup](https://claude.ai/code/artifact/31579436-1abf-48f8-b320-8740c4029b0f) |
| Onboarding gate (name, wrap, run) and installer screens | `/{org}` before unlock | loaded, waiting, unlocked, phone | [W1 mockup](https://claude.ai/code/artifact/31579436-1abf-48f8-b320-8740c4029b0f) |
| Fleet | `/{org}/{ws}` | loaded, empty (first run), loading, error, denied, phone | [W1 mockup](https://claude.ai/code/artifact/31579436-1abf-48f8-b320-8740c4029b0f), [W2 mockup](https://claude.ai/code/artifact/0b3eae2f-4fd9-45a5-b667-e04367999d1d), [W5 mockup](https://claude.ai/code/artifact/81725124-b936-4cbb-9e40-79089b5a1e35), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Approvals panel | on Fleet and Run | loaded, empty, phone | [W2 mockup](https://claude.ai/code/artifact/0b3eae2f-4fd9-45a5-b667-e04367999d1d), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Run (live, sealed, compacted) | `/{org}/{ws}/runs/{run}` | loaded, loading, error, denied, phone | [W2 mockup](https://claude.ai/code/artifact/0b3eae2f-4fd9-45a5-b667-e04367999d1d), [W5 mockup](https://claude.ai/code/artifact/81725124-b936-4cbb-9e40-79089b5a1e35), [W6 mockup](https://claude.ai/code/artifact/2bbadccb-92ff-4ade-8f6d-704d9c66dafe), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W4 mockup](https://claude.ai/code/artifact/a4b69d0b-715c-434c-9f4e-80534bf2e462), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Agents (list, detail, mandate detail) | `/{org}/{ws}/agents`, `/{agent}` | loaded, empty, error, denied, phone | [W6 mockup](https://claude.ai/code/artifact/2bbadccb-92ff-4ade-8f6d-704d9c66dafe), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W9](https://claude.ai/code/artifact/c16a2951-1a79-4c70-b202-ec405c0563dc), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Tools (registry, connections, mandates, policy, kill switches, assurance) | `/{org}/{ws}/tools` | loaded, empty, error, denied, phone | [W5 mockup](https://claude.ai/code/artifact/81725124-b936-4cbb-9e40-79089b5a1e35), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W9](https://claude.ai/code/artifact/c16a2951-1a79-4c70-b202-ec405c0563dc), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Ontology (Model, Graph, Sources, Repositories, Versions) | `/{org}/{ws}/ontology` | loaded, empty, loading, error, denied, phone | [W7 mockup](https://claude.ai/code/artifact/8692f683-0eab-4a1f-ad66-20f4a1a2db5b), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Skills (Catalog, Search, In the loop, Reflection, Versions) | `/{org}/{ws}/skills[/{tab}]` | loaded, empty, loading, error, denied, off (the gate), phone | [W13 scenario](https://github.com/macanderson/tmp-oxagen-mockups/blob/main/docs/w13-in-the-loop-scenario.md) |
| Steering (records, proposals, Context PR, retirement) | `/{org}/{ws}/steering` | loaded, empty, error, denied, phone | [W6 mockup](https://claude.ai/code/artifact/2bbadccb-92ff-4ade-8f6d-704d9c66dafe), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Spend (findings, operator, agent, waterfall, reconciliation, budgets) | `/{org}/{ws}/spend` | loaded, empty, loading, error, denied, phone | [W5 mockup](https://claude.ai/code/artifact/81725124-b936-4cbb-9e40-79089b5a1e35), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W8 mockup](https://claude.ai/code/artifact/6a15975f-6719-4b4c-aae5-4b942dea0bb1), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Organization | `/{org}` | loaded, denied, phone | [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W10](https://claude.ai/code/artifact/403166f6-9216-4d23-86ac-bb3c2aa60b23), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Billing | `/{org}/billing` | loaded, error, denied, phone | [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W8 mockup](https://claude.ai/code/artifact/6a15975f-6719-4b4c-aae5-4b942dea0bb1), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Audit | `/{org}/audit` | loaded, empty, error, denied, phone | [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W10](https://claude.ai/code/artifact/403166f6-9216-4d23-86ac-bb3c2aa60b23), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Assistant panel | every page | collapsed, open, engine down, phone | [W1 mockup](https://claude.ai/code/artifact/31579436-1abf-48f8-b320-8740c4029b0f), [W5 mockup](https://claude.ai/code/artifact/81725124-b936-4cbb-9e40-79089b5a1e35), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W4 mockup](https://claude.ai/code/artifact/a4b69d0b-715c-434c-9f4e-80534bf2e462), [W10](https://claude.ai/code/artifact/403166f6-9216-4d23-86ac-bb3c2aa60b23), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |
| Account dialog, notifications, command menu | user menu, top bar | loaded, phone | [W5 mockup](https://claude.ai/code/artifact/81725124-b936-4cbb-9e40-79089b5a1e35), [W11 mockup](https://claude.ai/code/artifact/317226a1-c2ff-43ce-a439-4a54f8b8288b), [W3 mockup](https://claude.ai/code/artifact/9a8bcd5c-c66c-462d-992a-a449679801ce), [W4 mockup](https://claude.ai/code/artifact/a4b69d0b-715c-434c-9f4e-80534bf2e462), [W10](https://claude.ai/code/artifact/403166f6-9216-4d23-86ac-bb3c2aa60b23), [W12 mockup](https://claude.ai/code/artifact/3fcf949a-c455-4efd-af36-1c2d1f13088e) |

---

## Appendix A. Postgres tables (target)

Thirty-five tables in nine schemas in the wedge, thirty-seven for the full product (`cost.fx_rates` and `control.event_subscriptions` arrive in Series A), down from about 110 tables in 20 schemas today. This is the definitive list. A table not here does not exist.

### A.0 Conventions that apply to every table

| Column | Type | On which tables | Notes |
|---|---|---|---|
| `id` | uuid (v7) | all | primary key; never shown outside the system |
| `public_id` | citext | all | prefixed (`org_`, `wrk_`, `agt_`, …), unique; the only id shown in the API and the UI |
| `created_at`, `updated_at` | timestamptz | all | |
| `created_by_id`, `updated_by_id` | uuid → `auth.users` | tables a person edits | |
| `deleted_at`, `deleted_by_id` | timestamptz, uuid | tables a person edits | rows are never hard-deleted |
| `org_id` | uuid → `org.organizations` | tenant class `org` and `workspace` | required; enforced by the policies in §5.2 |
| `workspace_id` | uuid → `wrk.workspaces` | tenant class `workspace` | required; enforced by the policies in §5.2 |

> **Amendment 2026-09-15 (ADR-077).** Attribution columns end in `_id` like every other reference column: `created_by_id`, `updated_by_id`, `deleted_by_id`, and the per-table `<verb>_by` columns below (`invited_by`, `granted_by`, `issued_by`, `approved_by`, `revoked_by`, `placed_by`, `released_by`) are `<verb>_by_id` when they hold a user or principal id. `control.approvals.resolved_by` keeps its name: it is text that may hold `policy:<rule id>`, not a reference. `createdBy` without a suffix is reserved for a resolved display name in a contract output (`iam.role.list`), never a column.

Money is `bigint` micro-USD unless a `currency` column says otherwise. Secrets are `bytea` ciphertext with `key_id` and `digest` beside them (the envelope pattern). Every `jsonb` column is validated against a schema in code before it is written. Enumerations are `text` with a check constraint; their values are listed in the Notes column.

### A.1 `auth` (4 tables, platform scope, Better Auth's own tables, unchanged)

**`auth.users`**

| Column | Type | Notes |
|---|---|---|
| `email` | citext | unique |
| `email_verified` | bool | |
| `name`, `image` | text | |
| `two_factor_enabled` | bool | |
| `banned`, `ban_reason`, `ban_expires` | bool, text, timestamptz | |

**`auth.sessions`**

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid → `auth.users` | |
| `token` | text | unique |
| `expires_at` | timestamptz | |
| `ip_address`, `user_agent` | text | |
| `active_org_id`, `active_workspace_id` | uuid | the org and workspace the session last used |
| `impersonated_by` | uuid → `auth.users` | null unless a support impersonation is active |

**`auth.accounts`**

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid → `auth.users` | |
| `provider_id`, `account_id` | text | the identity provider and the id there |
| `access_token`, `refresh_token`, `id_token` | text | provider tokens for SSO |
| `expires_at` | timestamptz | |
| `scope` | text | |
| `password` | text | hash, for email and password accounts |

**`auth.verifications`**

| Column | Type | Notes |
|---|---|---|
| `identifier`, `value` | text | |
| `expires_at` | timestamptz | |

### A.2 `org` (3 tables)

**`org.organizations`** (platform scope; the tenant itself)

| Column | Type | Notes |
|---|---|---|
| `name` | text | |
| `slug` | citext | unique |
| `namespace` | citext | 2 to 6 characters, unique, immutable; used in agent keys and the Neo4j database name |
| `status` | text | `active`, `suspended`, `deleted` |
| `plan` | text | `free`, `team`, `enterprise` |
| `stripe_customer_id` | text | |
| `display_currency`, `billing_currency` | text | ISO 4217 codes |
| `default_locale` | text | BCP 47 tag |
| `deployment_mode` | text | `cloud`, `self_hosted` |
| `onboarding_state` | text | `gated`, `unlocked` |
| `unlocked_at`, `discount_offered_at` | timestamptz | |
| `kek_key_id` | text | the organization's key-encryption key in KMS |
| `neo4j_database` | text | `org_<namespace>` |
| `neo4j_instance_id` | text | which instance hosts the database (§5.3 sharding) |
| `funding_source` | text | `platform`, `customer_key` |
| `funding_connection_id` | uuid → `tools.connections` | the customer's model provider key, when `customer_key` |
| `model_routes` | jsonb | tier → provider, model, fallback (§4.5) |
| `retention_days` | int | default 2555 (seven years) |
| `retention_mode` | text | `content_exact`, `digest_only` |
| `assistant_spend_cap_micros` | bigint | cap on tokens Oxagen buys on the organization's behalf |
| `deny_generation` | bigint | bumped to invalidate every cached policy bundle in the organization |
| `settings` | jsonb | |

**`org.org_users`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid → `auth.users` | unique with `org_id` |
| `role` | text | `owner`, `admin`, `member`, `billing`, `compliance`, `viewer` |
| `status` | text | `invited`, `active`, `removed` |
| `invited_by` | uuid → `auth.users` | |
| `invite_token_hash`, `invite_expires_at` | text, timestamptz | |
| `joined_at` | timestamptz | |

**`org.data_planes`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `store` | text | `postgres`, `neo4j`, `objects`; unique with `org_id` |
| `mode` | text | `shared`, `dedicated` |
| `config_ciphertext`, `key_id`, `digest` | bytea, text, text | the connection configuration, enveloped |
| `status` | text | `active`, `degraded`, `rotating` |
| `schema_version` | text | the migration version applied on this plane |
| `last_health_at`, `rotated_at` | timestamptz | |

### A.3 `wrk` (3 tables)

**`wrk.workspaces`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `name` | text | |
| `slug` | citext | unique per organization |
| `namespace` | citext | unique per organization, immutable |
| `governance_mode` | text | `solo`, `team`, `regulated` |
| `retention_mode` | text | override of the organization's, or null |
| `active_ontology_version` | text | graph id of the pinned version |
| `bundle_version` | bigint | bumped on every publish or grant change |
| `deny_generation` | bigint | workspace-level kill switch counter |
| `promotion_policy` | jsonb | support runs, distinct agents, confidence floor (§9.2) |
| `context_branch` | text | null means the default branch |
| `settings` | jsonb | |

**`wrk.workspace_users`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid → `auth.users` | unique with `workspace_id` |
| `role` | text | `owner`, `member`, `viewer` |
| `status` | text | `invited`, `active`, `removed` |
| `invited_by` | uuid → `auth.users` | |
| `invite_token_hash`, `invite_expires_at` | text, timestamptz | |

**`wrk.repositories`** (class `workspace`; one row per link)

| Column | Type | Notes |
|---|---|---|
| `installation_id` | bigint | the GitHub App installation |
| `github_repo_id` | bigint | unique with `workspace_id` |
| `full_name` | text | `owner/name` |
| `role` | text | `main`, `linked`; a partial unique index enforces one `main` per workspace |
| `default_branch` | text | as GitHub reports it |
| `production_branch` | text | confirmed by the customer (§11.4) |
| `issues_enabled` | bool | |
| `last_indexed_sha`, `last_indexed_at` | text, timestamptz | head of the code graph |
| `indexing_status` | text | `idle`, `indexing`, `failed` |
| `issue_backfill_status`, `issue_backfill_cursor` | text | |
| `event_subscription_id`, `last_event_delivery_id` | text | webhook bookkeeping |

### A.4 `iam` (5 tables)

**`iam.principals`** (class `org`; `workspace_id` required when `kind = 'agent'`)

| Column | Type | Notes |
|---|---|---|
| `kind` | text | `human`, `agent`, `service` |
| `user_id` | uuid → `auth.users` | humans only |
| `agent_key` | citext | `org_ns.ws_ns.slug`, unique; agents only |
| `harness` | text | `stella`, `claude-code`, `codex-cli`, `openai-agents-sdk`, `claude-agent-sdk`, `custom`, `oxagen-service` |
| `harness_version` | text | |
| `parent_user_id` | uuid → `auth.users` | the operator an agent acts for |
| `definition_path` | text | `.oxagen/agents/<slug>.toml` in the main repo (§6.2) |
| `definition_digest`, `definition_commit_sha` | text | at the last merged commit |
| `status` | text | `unenrolled`, `active`, `suspended`, `retired` |
| `display_name` | text | |

**`iam.roles`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `name` | text | unique per organization |
| `scope_kind` | text | `org`, `workspace`, `agent` |
| `builtin` | bool | the seeded roles cannot be deleted |
| `description` | text | |

**`iam.role_grants`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `role_id` | uuid → `iam.roles` | |
| `subject_kind` | text | `tool`, `agent_tool` |
| `subject` | text | a name or a glob with version, for example `github__*@*`; unique with `role_id` and `subject_kind` |
| `effect` | text | `allow`, `deny`, `require_approval` |
| `resource_scope` | jsonb | graph labels and relationship types, hop, node, and time budgets, repositories, side-effect classes, egress classes, spend limits (§6.3) |
| `conditions` | jsonb | reference to a Cedar fragment (§6.12) |

**`iam.principal_role_assignments`** (class `org`; `workspace_id` null means organization-wide)

| Column | Type | Notes |
|---|---|---|
| `principal_id` | uuid → `iam.principals` | unique with `role_id` and `workspace_id` |
| `role_id` | uuid → `iam.roles` | |
| `granted_by` | uuid → `auth.users` | |
| `expires_at` | timestamptz | |

**`iam.credentials`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `principal_id` | uuid → `iam.principals` | |
| `kind` | text | `api_key`, `agent_credential`, `host_device_key`, `service_token` |
| `purpose` | text | `human`, `wrap_host`, `agent`, `service` |
| `prefix` | text | the visible key prefix |
| `secret_hash` | text | |
| `public_key` | text | device keys only |
| `scope` | jsonb | |
| `expires_at`, `last_used_at` | timestamptz | |
| `revoked_at`, `revoked_by` | timestamptz, uuid | |

### A.5 `tools` (7 tables)

**`tools.tool_servers`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `name` | text | unique per workspace |
| `kind` | text | `mcp`, `http`, `harness`, `oxagen` |
| `endpoint` | text | |
| `transport` | text | `streamable_http`, `stdio`, `openapi`, `builtin` |
| `connection_id` | uuid → `tools.connections` | null for servers that need no credential |
| `status` | text | `active`, `disabled`, `killed` |
| `last_import_at`, `last_import_digest` | timestamptz, text | |
| `egress_class` | text | `local`, `org_tenant`, `third_party` |

**`tools.tool_versions`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `server_id` | uuid → `tools.tool_servers` | |
| `name`, `version` | text | unique with `server_id` |
| `description` | text | |
| `input_schema` | jsonb | JSON Schema 2020-12 |
| `output_schema` | jsonb | null until declared or approved |
| `schema_digest` | text | |
| `schema_origin` | text | `declared`, `imported`, `observed_proposed`, `observed_approved` |
| `risk` | text | `low`, `medium`, `high`, `critical` |
| `side_effect` | text | `read`, `write`, `irreversible` |
| `consequence_tags` | text[] | starter set plus customer tags (§6.9) |
| `measures` | jsonb | name → path, type, unit or currency path |
| `data_classes` | text[] | from the data layer (§11.7) |
| `idempotency` | jsonb | supported flag and key path |
| `credential_scope` | jsonb | connection kind and downscope method |
| `price_micros`, `price_unit` | bigint, text | for tools with a declared price |
| `status` | text | `proposed`, `active`, `deprecated`, `killed` |
| `approved_by` | uuid → `auth.users` | |

**`tools.connections`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `name` | text | |
| `kind` | text | `oauth`, `api_key`, `cloud_role`, `github_app`, `model_provider` |
| `provider` | text | |
| `owner_user_id` | uuid → `auth.users` | the accountable person |
| `requires_mandate` | bool | true when any tool it backs carries a consequence tag |
| `secret_ciphertext`, `key_id`, `digest` | bytea, text, text | enveloped |
| `oauth_scopes` | text[] | |
| `downscope_method` | text | `token_exchange`, `session_policy`, `restricted_key`, `none` |
| `review_at` | timestamptz | |
| `status` | text | `active`, `expired`, `revoked` |
| `last_tested_at`, `last_test_result` | timestamptz, text | |
| `two_person_required` | bool | |

**`tools.credential_grants`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `connection_id` | uuid → `tools.connections` | |
| `tool_call_id` | uuid → `control.tool_calls` | |
| `run_id` | text | graph id |
| `scope` | jsonb | what the minted credential could reach |
| `provider_token_id` | text | the provider's identifier for the token, where one exists |
| `issued_at`, `expires_at`, `revoked_at` | timestamptz | |

**`tools.mandates`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `agent_principal_id` | uuid → `iam.principals` | |
| `granted_by`, `second_approver` | uuid → `auth.users` | |
| `role_at_grant` | text | the granter's role at the time |
| `consequence_tags` | text[] | |
| `limits` | jsonb | measure → per_call, per_period, period, currency or unit |
| `targets` | jsonb | measure → allow and deny lists |
| `tools` | text[] | patterns |
| `approval_rules` | jsonb | human_above by measure, always_human_for tags, approvers |
| `purpose` | text | |
| `valid_from`, `valid_to` | timestamptz | |
| `status` | text | `active`, `suspended`, `expired`, `revoked` |
| `revoked_by`, `revoked_reason` | uuid, text | |

**`tools.mandate_ledger`** (class `workspace`; append-only)

| Column | Type | Notes |
|---|---|---|
| `mandate_id` | uuid → `tools.mandates` | |
| `tool_call_id` | uuid → `control.tool_calls` | |
| `kind` | text | `reserve`, `settle`, `release` |
| `measure` | text | |
| `value` | numeric | |
| `unit_or_currency` | text | |
| `external_effect_id` | text | the transaction, migration, message, or deployment id |
| `period_key` | text | for example `2026-09` |
| `balance_after` | numeric | |

**`tools.policy_versions`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `version` | int | unique per workspace |
| `cedar_text` | text | |
| `digest` | text | |
| `tests` | jsonb | the policy's own test cases |
| `test_result` | text | |
| `simulation_id`, `simulation_summary` | text, jsonb | would-deny, would-approve, would-allow counts and the runs (§6.12) |
| `authored_by`, `approved_by` | uuid → `auth.users` | |
| `activated_at` | timestamptz | |
| `status` | text | `draft`, `simulated`, `active`, `superseded` |

### A.6 `control` (4 tables in the wedge, 5 with event subscriptions)

**`control.enrollments`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `host_principal_id` | uuid → `iam.principals` | |
| `hostname`, `os_user`, `platform` | text | |
| `harness`, `harness_version` | text | `claude-code`, `codex-cli` |
| `device_public_key` | text | |
| `managed` | bool | enterprise managed enrollment |
| `enrollment_claims`, `enrollment_signature` | jsonb, text | |
| `bundle_version_served` | bigint | |
| `status` | text | `active`, `paused`, `suspended`, `revoked` |
| `last_seen_at`, `expires_at` | timestamptz | |

**`control.commands`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `target_kind` | text | `run`, `agent`, `host`, `tool_version`, `tool_server`, `connection`, `workspace`, `org`, `class` |
| `target_id` | text | |
| `command` | text | `pause`, `resume`, `steer`, `message`, `cancel`, `revoke`, `kill_switch_on`, `kill_switch_off`, `refresh_bundle` |
| `payload` | jsonb | steer or message text, delivery mode, addressing |
| `issued_by` | uuid → `iam.principals` | |
| `issued_at`, `expires_at` | timestamptz | |
| `delivered_at`, `acknowledged_at`, `applied_at` | timestamptz | |
| `applied_at_seq` | bigint | the frame sequence the effect landed on |
| `status` | text | the closed vocabulary of §7.4: `draft`, `queued`, `sent`, `received`, `acknowledged`, `applied`, `cancelled`, `expired`, `failed` |
| `outcome_detail`, `reason` | text | |

**`control.approvals`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `tool_call_id` | uuid → `control.tool_calls` | |
| `run_id` | text | graph id |
| `agent_principal_id`, `operator_principal_id` | uuid → `iam.principals` | |
| `action` | text | the canonical action |
| `input_digest` | text | |
| `mandate_id` | uuid → `tools.mandates` | |
| `rule_ids` | text[] | the policy rules that required approval |
| `taint_sources` | text[] | |
| `requested_at`, `expires_at`, `resolved_at` | timestamptz | |
| `resolved_by` | text | a user id, or `policy:<rule id>` for an auto-approval |
| `decision` | text | `approved`, `denied`, `expired` |
| `reason` | text | |
| `token_id`, `token_bound_digest`, `token_expires_at` | text, text, timestamptz | the single-use approval token |
| `token_used_at`, `token_use_count` | timestamptz, int | |

**`control.tool_calls`** (class `workspace`)

| Column | Type | Notes |
|---|---|---|
| `run_id`, `attempt_id` | text | graph ids |
| `turn_seq`, `step_seq` | int | |
| `agent_principal_id` | uuid → `iam.principals` | |
| `tool_version_id` | uuid → `tools.tool_versions` | |
| `input_digest` | text | |
| `idempotency_key` | text | unique per workspace within the tool's window |
| `tainted` | bool | |
| `decision` | text | `allow`, `approve`, `deny` |
| `decision_rule_ids` | text[] | |
| `policy_version` | int | |
| `approval_id` | uuid → `control.approvals` | |
| `credential_grant_id` | uuid → `tools.credential_grants` | |
| `status` | text | `decided`, `parked`, `dispatched`, `completed`, `denied`, `failed`, `duplicate` |
| `dispatched_at`, `completed_at` | timestamptz | |
| `output_digest` | text | |
| `external_effect_ids` | jsonb | |
| `receipt_frame_seq` | bigint | |
| `enforcement_tier` | text | `gateway`, `harness`, `observe` |

**`control.event_subscriptions`** (class `org`, `workspace_id` nullable; Series A)

| Column | Type | Notes |
|---|---|---|
| `name` | text | |
| `event_kinds` | text[] | from the catalog in §7.7 |
| `filters` | jsonb | agent, operator, severity |
| `mode` | text | `push`, `pull` |
| `endpoint_id` | text | unique; the generated endpoint |
| `target_url` | text | push mode |
| `secret_ciphertext`, `key_id`, `secret_rotated_at` | bytea, text, timestamptz | the signing secret |
| `status` | text | `active`, `paused`, `dead_lettered` |
| `last_delivery_at`, `failed_deliveries` | timestamptz, int | |

### A.7 `cost` (4 tables in the wedge, 5 with exchange rates)

**`cost.price_entries`** (platform scope; `org_id` nullable, set for an organization's negotiated override)

| Column | Type | Notes |
|---|---|---|
| `provider` | text | |
| `model` | text | canonical model id |
| `model_aliases` | text[] | |
| `region` | text | |
| `token_class` | text | `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning`, `server_tool_request`, `embedding_input`, `rerank` |
| `unit` | text | |
| `currency` | text | ISO 4217 |
| `micros_per_million` | bigint | |
| `effective_from`, `effective_to` | timestamptz | |
| `source` | text | `list`, `negotiated`, `override` |

**`cost.fx_rates`** (platform scope; Series A)

| Column | Type | Notes |
|---|---|---|
| `base_currency`, `quote_currency` | text | unique with `effective_at` |
| `rate` | numeric(18,8) | |
| `source` | text | |
| `effective_at` | timestamptz | |

**`cost.run_totals`** (class `workspace`; a derived rollup, rebuildable from frames)

| Column | Type | Notes |
|---|---|---|
| `run_id` | text | graph id, unique |
| `operator_principal_id`, `agent_principal_id` | uuid → `iam.principals` | |
| `task_ref` | text | issue, PR, or free text |
| `repository_id` | uuid → `wrk.repositories` | |
| `started_at`, `sealed_at` | timestamptz | |
| `turns`, `steps`, `model_calls`, `tool_calls` | int | |
| `tokens` | jsonb | by token class |
| `cost_micros` | bigint | |
| `currency` | text | |
| `cost_basis` | text | `gateway_observed`, `client_attested`, `mixed`, `estimated` |
| `cache_hit_rate` | numeric | |
| `tool_definition_tokens`, `context_frame_tokens`, `steering_tokens` | int | |
| `retries` | int | |
| `verdict` | text | `flipped`, `failing`, `unmoved`, `unsatisfied`, `tampered`, `unverified`, `waived`, `none` |
| `accepted` | bool | a human verified the outcome without a witness |
| `productive_ratio` | numeric | |
| `enforcement_tier` | text | `gateway`, `harness`, `observe` |
| `replay_grade` | text | `inspect`, `view`, `fork`, `retry` |
| `governed_actions` | int | |
| `billed_at` | timestamptz | |

**`cost.provider_usage`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `connection_id` | uuid → `tools.connections` | |
| `provider`, `provider_key_id` | text | |
| `usage_date` | date | |
| `model`, `token_class` | text | |
| `units` | bigint | |
| `provider_micros` | bigint | |
| `invoice_id`, `invoice_line_ref` | text | |
| `imported_at`, `import_digest` | timestamptz, text | |

**`cost.reconciliations`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `period_start`, `period_end` | date | |
| `provider`, `provider_key_id` | text | |
| `level` | text | `request_id`, `key_day`, `invoice_line` |
| `matched_micros`, `provider_micros`, `variance_micros` | bigint | |
| `status` | text | `matched`, `variance`, `exception`, `resolved` |
| `unmatched_frames`, `unmatched_lines` | jsonb | |
| `resolved_by`, `resolution_note` | uuid, text | |

### A.8 `billing` (2 tables)

> **Amendment 2026-09-13 (ADR-055).** `included_runs`, `overage_price_micros`, `retention_price_micros_per_gb_month`, `runs_this_period` and `retained_gb` on `billing.subscriptions` are superseded. The subscription row keeps Stripe's own fields (`stripe_subscription_id`, `plan_id`, `status`, `billing_interval`, `current_period_start`, `current_period_end`, `cancel_at_period_end`). The billing schema is:
>
> | Table | Class | Columns |
> |---|---|---|
> | `billing.plans` | platform | tier, prices, seats, and the published terms `currency`, `rate_per_gau_micros`, `block_size_gau`, `included_gau_per_month`; CHECK `(rate_per_gau_micros * block_size_gau) % 10000 = 0` |
> | `billing.contract_terms` | `org` | `agreement_ref`, `currency`, `rate_per_gau_micros`, `block_size_gau`, `included_gau_per_month`, `effective_from`, `effective_to` (nullable); at most one row per org with `effective_to IS NULL`; the same CHECK |
> | `billing.subscriptions` | `org` | as above; the entitled subscription names the plan whose published terms apply when no negotiated row is effective |
> | `billing.org_billing_settings` | `org` | `stripe_customer_id`; `approved_for_invoice_billing` (default false), `invoice_gau_max` (default 100000, read only when approved); `auto_topup_enabled` (default true), `auto_topup_blocks` (default 1); the existing dunning state |
> | `billing.gau_buckets` | `org` | `period_start`, `period_end`, `included_gau`, `purchased_gau`, `carried_gau`, `used_gau`, `overage_invoiced_gau`, `interim_seq`, `topup_seq`, `open_topup_settlement_id`, `closed_at`; unique `(org_id, period_start)` |
> | `billing.gau_settlements` | `org` | `bucket_id`, `kind`, `seq`, `quantity_gau`, `rate_per_gau_micros`, `currency`, `status`, `stripe_checkout_session_id`, `stripe_invoice_id`, `created_at`, `settled_at`; unique `(bucket_id, kind, seq)` and `(stripe_checkout_session_id)` |
> | `billing.invoices` | `org` | the webhook mirror of Stripe's invoices (amount, status, hosted URL, period), joined to `gau_settlements` on `stripe_invoice_id` by `list_invoices` |
> | `billing.payment_methods` | `org` | the webhook mirror of the saved cards; the default one is what auto top-up and an interim invoice charge |
> | `billing.budgets` | `org` | unchanged, below |

**`billing.subscriptions`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `stripe_subscription_id` | text | |
| `plan`, `status` | text | |
| `included_runs` | int | |
| `overage_price_micros` | bigint | |
| `retention_included_months` | int | |
| `retention_price_micros_per_gb_month` | bigint | |
| `current_period_start`, `current_period_end` | timestamptz | |
| `runs_this_period` | int | |
| `retained_gb` | numeric | |
| `assistant_micros_this_period` | bigint | |
| `cancel_at` | timestamptz | |

**`billing.budgets`** (class `org`; `workspace_id` nullable)

| Column | Type | Notes |
|---|---|---|
| `scope_kind` | text | `org`, `workspace`, `operator`, `agent` |
| `scope_id` | text | |
| `limit_micros` | bigint | |
| `period` | text | `daily`, `monthly`, `rolling` |
| `window_days` | int | rolling budgets |
| `mode` | text | `hard`, `soft` |
| `notify_at` | int[] | percentages |
| `spent_micros` | bigint | running counter |
| `period_key` | text | |
| `breached_at` | timestamptz | |

### A.9 `audit` (3 tables)

**`audit.audit_events`** (class `org`; `workspace_id` nullable; append-only; seven-year retention)

| Column | Type | Notes |
|---|---|---|
| `kind` | text | control-plane action kinds, plus incident kinds: `unobserved_session`, `hooks_removed`, `chain_break`, `token_replay`, `witness_probe`, `mandate_exception`, `steering_drift`, `credential_probe` |
| `severity` | int | 1, 3, or 10 |
| `actor_principal_id` | uuid → `iam.principals` | |
| `target_kind`, `target_id` | text | |
| `run_id` | text | graph id, nullable |
| `detected_by` | text | `gateway`, `collector`, `control_plane`, `human` |
| `evidence` | jsonb | |
| `occurred_at` | timestamptz | |
| `resolved_at`, `resolved_by`, `resolution_note` | timestamptz, uuid, text | incidents only |

**`audit.archive_segments`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `run_id`, `attempt_id` | text | graph ids |
| `object_key` | text | in the organization's write-once bucket |
| `bytes`, `frame_count` | bigint | |
| `merkle_root`, `segment_digest` | text | |
| `attestation_key_id`, `attestation_signature` | text | |
| `sealed_at` | timestamptz | |
| `retention_until` | timestamptz | |
| `lock_mode` | text | `compliance` |
| `compacted_at` | timestamptz | when the frame nodes left the graph |
| `legal_hold_id` | uuid → `audit.legal_holds` | |

**`audit.legal_holds`** (class `org`)

| Column | Type | Notes |
|---|---|---|
| `scope_kind` | text | `run`, `agent`, `workspace`, `org` |
| `scope_id` | text | |
| `reason` | text | |
| `placed_by`, `placed_at` | uuid, timestamptz | |
| `released_by`, `released_at` | uuid, timestamptz | |

### A.10 Where today's tables went

| Today | In the rebuild |
|---|---|
| `agent.agent_runs*`, `agent.agent_executions*`, `tacho_*`, every ClickHouse table | graph nodes (`:Run`, `:Attempt`, `:Frame`) and archive segments |
| `iam.authorization_decisions` | `policy.decision` frames |
| `iam.deny_generations` | the two counters on `org.organizations` and `wrk.workspaces` |
| `schema_registry.*` | ontology versions in the graph, loaded from `.oxagen/ontology/` (§11.8) |
| `billing.credit_*`, `billing.reseller_*`, `billing.invoices`, `billing.payment_methods` | gone; Stripe holds invoices and cards. **Amendment 2026-09-13 (ADR-055):** `billing.invoices` is retained as the webhook mirror (`list_invoices` reads it and labels each invoice's kind through `gau_settlements`), and `billing.payment_methods` as the mirror of the saved default card that auto top-up charges; Stripe stays the system of record for both. `billing.credit_*` stays only for the ADR-053 platform-funded assistant balance, which starts at zero for a new organization |
| `security.security_events`, `privacy.*` requests | `audit.audit_events` |
| `ingestion.*` cursors and health | columns on `wrk.repositories` and `tools.tool_servers`, and `:Source` nodes |
| `chat.*` conversations | runs of the in-app agent |
| `mcp.*`, `plugin.*`, `content.*`, `cms.*`, `environments.*`, `eval.*`, `workflow.*`, `ai.*`, `ratelimit.*`, `engram.*`, `codegraph.*` | gone |

The nine schemas are `auth`, `org`, `wrk`, `iam`, `tools`, `control`, `cost`, `billing`, `audit`. Thirty-five tables in the wedge, thirty-seven in full. Every tenant table uses one of the two policy classes in §5.2.

## Appendix B. Neo4j model (per organization database)

Every organization has its own database (§5.3). Every node and relationship carries `ws` (the workspace public id), and every node carries `id` (its public id), `created_at`, `valid_from`, `valid_to`, `recorded_at`, and `is_system`. The tables below list what is specific to each label and relationship type.

### B.1 Node labels

| Layer | Label | Key properties | What it is |
|---|---|---|---|
| Reference | `Workspace` | `id` | reference node for a workspace; fields live in Postgres |
| Reference | `Principal` | `id`, `kind` | reference node for an operator, agent, or service |
| Reference | `Agent` | `id`, `agent_key`, `definition_digest` | reference node for an agent identity |
| Ontology | `Ontology` | `id` | one per workspace |
| Ontology | `OntologyVersion` | `version`, `digest`, `commit_sha`, `activated_at`, `enforcement_mode` | one per merged version of `.oxagen/ontology/` (§11.8) |
| Ontology | `Class` | `name`, `description`, `natural_key`, `synonyms`, `sensitivity` | a kind of entity |
| Ontology | `Property` | `name`, `type`, `required`, `unit` | a property of a class |
| Ontology | `RelationType` | `name`, `start_label`, `end_label`, `cardinality` | a kind of relationship between classes |
| Source | `Source` | `connector`, `connection_id`, `status` | a connected system (GitHub, Linear, Postgres) |
| Source | `SyncRun` | `started_at`, `ended_at`, `records`, `status` | one synchronization |
| Source | `SourceRecord` | `external_id`, `digest`, `synced_at`, `payload_ref` | one raw record as ingested |
| Source | `Event` | `delivery_id`, `kind`, `actor`, `occurred_at`, `payload_digest` | one repository event (§11.4) |
| Entity | `Entity` + class label | `natural_key`, `display_name`, class properties, `embedding_*` | a resolved thing; the class label is dynamic (`:Customer`, `:Ticket`) |
| Entity (GitHub fragment) | `Repository`, `Branch`, `Commit`, `PullRequest`, `Issue`, `Release`, `File`, `Symbol` | per class | the built-in code and repository classes |
| Entity (data layer) | `Database`, `Schema`, `Table`, `Column`, `Index`, `Constraint`, `View`, `Migration`, `StorageBucket`, `Queue`, `Topic`, `Cache`, `Secret`, `DatabaseInstance` | per class | the built-in data classes (§11.7) |
| Context | `Record` | `record_id`, `lineage_id`, `record_kind`, `record_hash`, `status`, `sharing_scope`, `confidence`, `origin`, `attestation` | a context record (§9) |
| Run | `Run` | `operator_id`, `agent_id`, `harness`, `task_ref`, `enforcement_tier`, `replay_grade`, `verdict`, `cost_micros`, `frame_count`, `merkle_root`, `segment_ref` | one run (§8.1) |
| Run | `Attempt` | `seq`, `kind` (`initial`, `resume`, `fork`), `engine`, `engine_version` | one attempt of a run |
| Run | `Frame` | `seq`, `kind`, `ts`, `hash`, `prev_hash`, `content_digest`, `bytes_ref`, `cost_micros`, `redactions` | one recorded event (§8.2); compacted after the hot window |
| Run | `Checkpoint` | `seq`, `signature`, `signer`, `countersignature` | a signed point in the chain |
| Run | `Seal` | `merkle_root`, `attestation_key_id`, `signature`, `sealed_at`, `completeness_gaps` | the end of an attempt |
| Proof | `Witness` | `witness_id`, `oracle`, `command_digest`, `authored_at`, `fingerprint` | a witness written by Oxagen (§8.5) |
| Proof | `Verdict` | `verdict`, `target_sha`, `pr_sha`, `fail_fingerprint`, `disclosure_grain`, `runner_attestation` | the outcome of running a witness |

### B.2 Relationship types

| Layer | Type | From → To | Properties | Meaning |
|---|---|---|---|---|
| Structure | `IN_WORKSPACE` | any node → `Workspace` | | membership, in addition to the `ws` property |
| Ontology | `HAS_VERSION` | `Ontology` → `OntologyVersion` | | |
| Ontology | `DEFINES` | `OntologyVersion` → `Class`, `RelationType` | | what a version contains |
| Ontology | `HAS_PROPERTY` | `Class` → `Property` | | |
| Entity | `INSTANCE_OF` | `Entity` → `Class` | `as_of_version` | |
| Entity | `DERIVED_FROM` | `Entity` → `SourceRecord` | `confidence`, `resolved_by` | provenance of every entity |
| Entity | `RELATES` | `Entity` → `Entity` | `type` (a `RelationType` name), class-specific properties | the customer's own relationships |
| Source | `PRODUCED` | `SyncRun` → `SourceRecord` | | |
| Source | `FROM_SOURCE` | `SyncRun` → `Source` | | |
| Source | `CONCERNS` | `Event` → `Entity` | | which entity a repository event is about |
| Context | `APPENDED` | `Run` → `Record` | `frame_seq` | which run appended a record |
| Context | `EVIDENCED_BY` | `Record` → `Frame` | | evidence links |
| Context | `SUPERSEDES`, `REFINES`, `CONTRADICTS` | `Record` → `Record` | | typed record links from the protocol |
| Context | `PROPOSES` | `Record` (proposal) → `Record` | | |
| Context | `PROMOTED_BY` | `Record` → `Record` (promotion event) | `pr_url`, `commit_sha`, `approver` | merge of a Context PR |
| Context | `ABOUT` | `Record` → `Entity` | | |
| Run | `IN_RUN` | `Frame` → `Run` | | |
| Run | `ATTEMPT_OF` | `Attempt` → `Run` | | |
| Run | `NEXT` | `Frame` → `Frame` | | the chain order |
| Run | `SEALED_BY` | `Attempt` → `Seal` | | |
| Run | `RAN_AS` | `Run` → `Agent` | | |
| Run | `OPERATED_BY` | `Run` → `Principal` | | the operator |
| Run | `FOR_TASK` | `Run` → `Issue` or `PullRequest` | | the task reference |
| Run | `USED_CONTEXT` | `Frame` → `Record` or `Entity` | `rendered`, `cited` | what a model call was given |
| Run | `DECIDED` | `Frame` → `Frame` | | a policy decision about a tool call |
| Run | `OPENED_BY` | `PullRequest` → `Run` | | a PR a run's side effect opened |
| Proof | `WITNESSED_BY` | `Run` → `Witness` | | |
| Proof | `VERDICT_OF` | `Verdict` → `Witness` | | |
| Proof | `MEASURED_AGAINST` | `Verdict` → `Commit` | `side` (`target`, `pr`) | the two commits a witness ran on |
| Proof | `RAN_IN` | `Verdict` → `Run` | | the witness runner's own run |
| Proof | `PROVED_BY` | `Run` → `Verdict` | | set only when the verdict is `flipped` |
| Code graph | `DEFINES` | `File` → `Symbol` | | |
| Code graph | `IMPORTS`, `CALLS`, `REFERENCES` | `Symbol` → `Symbol` or `File` | `evidence` | |
| Code graph | `INTRODUCED_IN`, `REMOVED_IN` | `File` or `Symbol` → `Commit` | | versioning of the code graph |
| Code graph | `HEAD_OF` | `Commit` → `Branch` | | |
| Data layer | `DEFINES_TABLE`, `ALTERS` | `Migration` → `Table` or `Column` | `order` | |
| Data layer | `DECLARED_BY` | `Table` → `Symbol` | `framework` | the model class that declares a table |
| Data layer | `READS`, `WRITES`, `DELETES`, `MIGRATES` | `Symbol` → `Table`, `Column`, or storage object | `confidence`, `operation`, `columns`, `evidence` | what code does to data |
| Data layer | `OBSERVED_ACCESS` | `Run` → data object | `frame_seq` | runtime confirmation |
| Data layer | `LIVE_MATCH` | `Table` (declared) → `Table` (synced) | `drift` | declared versus live schema |

### B.3 Constraints and indexes

| Kind | On | Purpose |
|---|---|---|
| Uniqueness | `id` on every label | one node per public id |
| Existence | `ws` on every label and relationship type | no node without a workspace |
| Uniqueness | (`ws`, `natural_key`) on `Entity` | one entity per natural key per workspace |
| Uniqueness | (`ws`, `record_id`) on `Record` | |
| Uniqueness | (`run_id`, `attempt_id`, `seq`) on `Frame` | dense sequence, no duplicates |
| Range | `ws`, `valid_from`, `valid_to`, every natural key | scoping and `as_of` queries |
| Vector | `entity_voyage4_1024`, `record_voyage4_1024`, `chunk_voyagecontext3_1024`, `symbol_voyagecode3_1024`, `run_voyage4_1024` | one index per label and embedding model (§11.5); never mixed |
| Full-text | one per searchable label | the keyword half of hybrid retrieval |

## Appendix C. Frame envelope (gateway kind example)

```json
{
  "v": "oxagen.frame/1.0",
  "event_id": "01J9…",
  "agent": { "agent_id": "a-intel.core.stella-ci", "fleet_id": "wrk_…", "runtime": "stella", "wrapper_version": "1.0.0" },
  "run_id": "run_…", "attempt_id": "arat_…", "seq": 42,
  "ts": "2026-09-11T14:03:22.118Z",
  "kind": "model.response",
  "fidelity": "gateway",
  "span": { "trace_id": "…", "span_id": "…", "parent_span_id": "…" },
  "body": {
    "provider": "anthropic", "model": "claude-fable-5-1", "provider_request_id": "req_…",
    "stop_reason": "tool_use", "latency_ms": 1840,
    "usage": { "input": 1834, "output": 412, "cache_read": 12000 },
    "cost": { "cost_micros": 41265, "price_entry_ids": ["pe_…"], "cost_basis": "gateway_observed" }
  },
  "content": { "digest": "sha256:…", "bytes_ref": "blob://org_…/sha256/…", "redactions": [] },
  "prev_hash": "sha256:…", "hash": "sha256:…"
}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | string | the envelope version, `oxagen.frame/1.0` |
| `event_id` | ULID | unique, time-ordered id of the frame |
| `agent` | object | `agent_id` (the agent key), `fleet_id` (the workspace), `runtime` (the harness), `wrapper_version` |
| `run_id`, `attempt_id` | string | which run and attempt this frame belongs to |
| `seq` | integer | position in the attempt, dense from 0; a gap is a `telemetry_gap` frame, never a repair |
| `ts` | string | UTC timestamp in the protocol's profile (uppercase `T` and `Z`) |
| `kind` | string | the frame kind (§8.2) |
| `fidelity` | string | `gateway`, `sdk`, or `harness`: who observed the event |
| `span` | object | OpenTelemetry trace, span, and parent ids for export |
| `body` | object | the kind-specific payload; for `model.response`: provider, model, provider request id, stop reason, latency, usage by token class, and the cost record (§12.3) |
| `content.digest` | string | SHA-256 of the exact body bytes stored outside the graph |
| `content.bytes_ref` | string | where the encrypted body is stored |
| `content.redactions` | array | what was removed before storage, with the digest of the removed text |
| `prev_hash`, `hash` | string | the hash chain: `hash` is SHA-256 over `prev_hash` and the canonical envelope without `hash` |

## Appendix D. Tool grant example

```json
{
  "role": "agent.contributor",
  "grants": [
    { "subject_kind": "tool", "subject": "github:*@*", "effect": "allow",
      "resource_scope": { "side_effects": ["read", "write"], "repositories": ["a-intel/platform"] } },
    { "subject_kind": "tool", "subject": "github:merge_pull_request@*", "effect": "require_approval" },
    { "subject_kind": "tool", "subject": "github:delete_*@*", "effect": "deny" },
    { "subject_kind": "capability", "subject": "recall_context", "effect": "allow",
      "resource_scope": { "graph": { "labels": ["Customer", "Ticket"], "mode": "read", "max_hops": 2 } } }
  ],
  "budget": { "per_run_micros": 5000000, "per_day_micros": 50000000, "mode": "enforced" }
}
```

| Field | Meaning |
|---|---|
| `role` | the role the grants belong to; an agent gets them through a role assignment (§6.3) |
| `grants[].subject_kind` | `tool` for an imported or harness tool, `agent_tool` for one of Oxagen's own (the example's `capability` is today's name and reads as `agent_tool` in the rebuild) |
| `grants[].subject` | a name or a glob with a version: `server:tool@version` |
| `grants[].effect` | `allow`, `deny`, or `require_approval`; deny always wins |
| `grants[].resource_scope` | the ceiling for that grant: side-effect classes, repositories, graph labels and mode, hop budget, egress classes, spend limits |
| `budget` | spend limits per run and per day, `enforced` at the model proxy or `observed` only |

How the four grants combine for this role: every GitHub tool is allowed for reads and writes on one repository, merging a pull request always waits for a human, deleting anything is denied outright, and the graph can be searched for customers and tickets two hops deep. Anything not named is denied, because the default effect is deny.

## Appendix E. The agent tools that survive

The current repository registers 229 real contracts (244 names minus test fixtures). The list below is the definitive set for the rebuild: **97 agent tools** (78 of them in the wedge), grouped by the job they serve. Each row names the new tool, what it absorbs from today's registry, and what it does. Anything not named here is **de-registered**, and the de-registrations are listed by family at the end. De-registered means the contract comes off the surfaces — it loses `app` from its `layers[]`, loses the `api` / `mcp` / `cli` entries in its `surfaces[]`, or loses its registration in `packages/handlers/src/register.ts`. It does **not** mean deleted. Every de-registered contract, handler, route, tool, page and package stays in the tree, keeps compiling and keeps its tests; `DEREGISTERED.md` at the repository root records each one with its file paths, and `pnpm check:deregistered` fails the build if any of those paths is removed. Deleting a de-registered feature takes an ADR under `docs/adr/` that names the files. Names follow ADR-025 (verb-first snake case, scope as an argument). Every tool has an input schema, an output schema, a risk grade, a default effect, and is exposed on API, MCP, and the UI unless marked headless.

**Organization and workspace (11)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `create_org` | create_org | organization, Neo4j database, keys, billing account |
| `update_org` | update_org_settings | name, settings, retention policy |
| `invite_member` | send_workspace_invite, add_org_member | invite to org or workspace with role |
| `respond_to_invite` | accept_member_invite, decline_member_invite | accept or decline |
| `set_member_role` | change_member_role, remove_org_member | set a role or remove (role `none`) at org or workspace |
| `list_members` | list_workspace_members | members with roles at either scope |
| `create_workspace` | create_workspace, configure_repo | workspace plus its main repo binding and production branch |
| `update_workspace` | update_workspace_settings, update_memory_policy, update_budget_policy, set_routing_policy | governance mode, retention mode, promotion thresholds, budgets, model routes |
| `list_workspaces` | list_workspaces, list_orgs | scoped listing |
| `get_data_plane` | get_data_plane | plane binding, DSN never returned |
| `set_data_plane` | set_data_plane | approval-gated |

**Identity and access (10)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `list_api_keys` | list_api_keys | read: the org's keys with principal, grants, last use and expiry; never the secret or its hash (added 2026-09-14 for the API keys page) |
| `create_api_key` | create_api_key | purpose-locked keys for humans and services |
| `rotate_api_key` | rotate_api_key | |
| `revoke_api_key` | revoke_api_key | |
| `register_agent` | create_agent_def, suggest_agent_def, summarize_agent_def | opens a Context PR adding `.oxagen/agents/<slug>.toml` and the generated harness files; identity is created on merge |
| `update_agent` | update_agent_def, revise_agent_def, publish_agent_def, deploy_agent | a Context PR changing the definition; identity and belt update on merge |
| `retire_agent` | delete_agent_def | a Context PR removing the file; principal retired, never deleted |
| `get_agent` | get_agent_def, get_agent_role | identity, roles, belt, mandates |
| `list_agents` | list_agent_defs | |
| `set_agent_role` | assign_agent_role, revoke_agent_role | |
| `set_role_grants` | (new; grants were seeded) | role's grants and resource scopes; `list_roles` is its read side, folded into `get_agent` and the Tools page |

**Wrapping and control (15)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `enroll_host` | create_tacho_enrollment, create_stella_enrollment (today's names) | device key, host agent, bundle, hooks |
| `revoke_enrollment` | revoke_tacho_enrollment | |
| `list_hosts` | list_tacho_hosts | |
| `get_policy_bundle` | get_tacho_bundle, get_registry_config | signed bundle for a host or agent |
| `ingest_frames` | ingest_tacho_events, record_execution, ingest_stella_operational_telemetry, debug_execution | the one evidence ingress; headless |
| `fetch_commands` | fetch_tacho_commands | control channel; headless |
| `dispatch_command` | dispatch_tacho_command | pause, resume, steer, cancel, revoke, answer (the reply to a `control.interject`, ADR-090) |
| `list_runs` | list_executions, list_tacho_sessions | by operator, agent, task, tier, verdict |
| `list_skills` | (new; `tacho.sessions.skills_available` had no reader) | read: the skill names the workspace's harness sessions reported at start, with sessions, harnesses and last seen over a window; Oxagen reports which skills the harness had and runs none (added 2026-09-15 for the Skills page, #3098) |
| `get_run` | get_tacho_session, get_execution_trace, get_message_execution | run with turns, steps, frames, receipts, cost |
| `export_run` | export_data (run part) | signed bundle with verifier |
| `list_approvals` | (new; approvals had no list) | queue with the four-hop chain |
| `resolve_approval` | resolve_approval, resolve_mcp_consent | approve or deny, mints the token |
| `send_message` | (new) | message to `@<agent-slug>`, `@agents`, or a run id, with a delivery mode; reaches `applied` at the model request that carried it (§7.3, §7.6) |
| `list_messages` | (new) | sent and received, with delivery outcome |

**Toolbelt (17)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `register_tool_server` | register_mcp_server, set_mcp_enabled | MCP or HTTP server |
| `remove_tool_server` | delete_mcp_server | |
| `list_tool_servers` | list_mcp_servers, resolve_mcp_servers, list_mcp_consents | |
| `import_tools` | list_tool_declarations, publish_tool_declaration, list_agent_tools | pull `tools/list`, version, store schemas |
| `approve_tool_schema` | (new) | accept an observed output schema |
| `search_tools` | search_command_menu, suggest_commands, list_agent tool_registry, get_agent tool_registry | belt search meta-tool; also the UI's command menu |
| `load_tools` | (new) | belt definitions meta-tool |
| `set_connection` | create_connection (credential part), set_model_credential, verify_model_credential, upsert_secret_key, set_secret_value, set_plugin_secret, reauth_plugin_credential | credential to a tool server or provider, tested before save |
| `delete_connection` | delete_connection, delete_model_credential, delete_secret_key, unset_secret_value, revoke_plugin_credential | |
| `list_connections` | list_connections, list_secret_keys, get_model_credential | never returns secrets |
| `grant_mandate` | (new) | bounded authority for a consequence tag to an agent |
| `set_approval_rules` | (new) | the customer's approval and auto-approval rules, as a policy version |
| `revoke_mandate` | (new) | |
| `list_mandates` | (new) | ledger view |
| `set_policy` | (new) | new policy version with tests |
| `simulate_policy` | (new) | replay a version against history |
| `set_kill_switch` | (new) | any level |

**Ontology and knowledge (13)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `link_repository` | configure_repo, sync_repo, install_integration (GitHub part) | link, role, production branch, issue import |
| `unlink_repository` | pause_repo, delete_integration | |
| `sync_repository` | sync_repo, resume_repo, sync_integration | manual full re-index |
| `add_source` | create_connection (ingestion part), install_plugin, configure_integration | connector source |
| `update_source` | update_connection, set_connection_mappings, suggest_connection_mappings, pause_connection, preview_connection | mappings, state |
| `remove_source` | delete_connection, uninstall_plugin | |
| `list_sources` | list_connections, list_integrations, list_plugins, get_integration, get_integration_metrics, get_reconcile_status | health, cursors, counts |
| `propose_ontology_version` | recommend_schema, setup_schema, create_schema_version, run_schema_chat, pin_schema_version, toggle_schema, dispatch_schema_reconcile | profiler plus author; opens the pull request on the main repo (merge activates, §11.8) |
| `get_ontology` | get_schema_registry, list_schema_versions, list_schemas, diff_schema_versions, export_schema, get_node_labels | active version, classes, relations, synonyms, proposals, diffs; also served to agents as `graph` frames |
| `update_ontology` | upsert_schema_label, upsert_schema_property, upsert_schema_relationship, delete_schema_label, delete_schema_property, delete_schema_relationship, validate_schema_node, validate_schema_relationship | edits on a proposal branch |
| `search_graph` | search_graph, search_nodes, search_references, list_nodes | hybrid semantic |
| `expand_graph` | get_ontology_neighbors, get_node | typed traversal |
| `query_graph` | query_ontology, get_graph_stats | natural language to Cypher |

**Context and steering (9)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `append_record` | write_memory, save_memory, attach_memory_evidence, cite_memory, cite_reference | the protocol's append |
| `get_record` | (new) | |
| `list_records` | list_context_records, list_memories, list_memory_citations, get_citation_stats | by kind, scope, status, lineage |
| `retract_record` | delete_memory, demote_memory | new record on the lineage |
| `recall_context` | recall_memory | the provider's query, as a tool for agents |
| `propose_record` | promote_memory, promote_context_record, suggest_promotion_rationales | a proposal |
| `open_context_pr` | publish_context_record | the pull request |
| `list_proposals` | list_memory_promotions | |
| `dismiss_proposal` | dismiss_memory_promotion | |

**Spend and billing (9)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `get_spend` | get_usage_breakdown, list_routing_stats, get_repo_metrics | rollups at any level with basis |
| `list_findings` | list_error_clusters | ranked optimizations |
| `get_reconciliation` | (new) | matched, variance, exceptions |
| `export_statement` | export_data (billing part) | |
| `set_budget` | set_spend_budget, get_spend_budget, update_user_budget, get_user_budget, get_budget_policy | any level |
| `set_model_route` | update_model_settings, get_model_settings, list_model_agent tools, preview_routing_decision, get_routing_policy | tiers and fallbacks |
| `set_funding_source` | (new; was implicit in credentials) | platform or customer key |
| `get_subscription` | get_subscription | |
| `change_subscription` | start_subscription_upgrade, purchase_credits | |

> **Amendment 2026-09-13 (ADR-055).** Six rows are added to this family (15) and one of today's contracts is retired. `get_action_usage`, which reported the dollar model, is dropped and gains no row. The count line below becomes 11 + 10 + 14 + 17 + 13 + 9 + 15 + 7 + 6 = **102**.
>
> | Agent tool | Absorbs | Does |
> |---|---|---|
> | `get_gau_bucket` | get_action_usage (retired) | the org's billing mode and the month's bucket: included, purchased, carried, used, remaining (GAU counts); the invoice thresholds and past-due flag in invoice billing; the auto top-up state in prepaid; a read that never writes |
> | `get_contract_rate` | (new) | the customer's contracted per-GAU rate, block size, block price, currency, included GAUs per month, effective dates and source (published tier or negotiated agreement), from `resolveContractTerms` |
> | `purchase_gau_bucket` | (new) | buy GAUs in unit quantities of the block size at the contracted rate; returns a Stripe Checkout URL; refuses an invoice-billed org |
> | `set_auto_topup` | (new) | Owner or Admin: `enabled`, `blocks` (1…100) for the prepaid auto top-up |
> | `set_org_billing_terms` | (new; headless, platform operator only) | `approved_for_invoice_billing`, `invoice_gau_max`; closes the accrual with an interim invoice when invoice billing is turned off; reachable only through the kernel's platform-operator binding (`pnpm billing:terms`) |
> | `list_invoices` | (new) | cursor-paged invoices from the webhook mirror with a kind per row (subscription, block purchase, auto top-up, interim, period close), amounts, status and the Stripe-hosted link |

**Audit and compliance (7)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `query_audit_log` | query_audit_log, get_auth_alerts | control-plane events, receipts |
| `export_data` | export_data | organization export |
| `erase_data` | erase_data | crypto-shred |
| `set_legal_hold` | (new) | |
| `list_incidents` | (new; incidents had no list) | tamper, probes, chain breaks, mandate exceptions |
| `set_event_subscription` | (new; Series A) | event kinds, filters, delivery mode; returns the unique endpoint (§7.7) |
| `list_event_subscriptions` | (new; Series A) | with delivery health and dead letters |

**Assistant and account (6)**

| Agent tool | Absorbs | Does |
|---|---|---|
| `ask_assistant` | send_message, post_conversation_message, add_conversation_attachment | a turn of the in-app agent |
| `list_conversations` | list_conversations, rename_conversation, archive_conversation, delete_conversation, export_conversation, purge_conversations, list_conversation_files | with the actions as arguments |
| `set_preferences` | update_user_preferences, get_user_preferences, update_workspace_user_preferences, get_workspace_user_preferences, set_auth_alerts | |
| `list_notifications` | list_notifications | |
| `mark_notification` | mark_notification | |
| `get_install_instructions` | get_install_instructions | per harness |

**De-registered, by family** (everything not named above, all of it kept in the tree per the preamble and `DEREGISTERED.md`): `environment.*` and `bind/unbind_agent_environment` (no runtime); `plugin.*`, `browse_plugin_catalog`, `add/remove_plugin_registry`, `install_plugins_bulk`, `sync_plugin_catalog`, `get_catalog_plugin`, `get_plugin_schema`, `validate_plugin_schema`, `list_plugin_registries`, `list_plugin_versions`, `set_plugin_enabled` (no marketplace in v1; sources and tool servers replace it); `prompt.settings.*` (steering replaces prompt settings); `import_env_secrets`, `export_secrets`, `reveal_secret` (secrets are connections and are never revealed); `parse_memory_import`, `commit_memory_import` (records are appended, not imported); `get_pr`, `get_pr_diff`, `list_branches`, `get_ci_status`, `read_file` (the graph and the GitHub events hold these; agents read code through their own harness); `upload_asset` (no content); `get_org_settings`, `get_workspace_settings`, `get_environment`, `get_connection`, `get_connection_mappings`, `get_memory_policy`, `get_prompt_settings`, `get_routing_policy` (reads folded into the objects above); everything in the test fixtures.

Two notes on that list. `read_file` has no registered contract on `main` — the only match is a test fixture in `packages/oxagen/src/contracts/tool.declaration.publish.test.ts` — so there is nothing to de-register and nothing to preserve. And the three plugin credential tools (`set_plugin_secret`, `revoke_plugin_credential`, `reauth_plugin_credential`) are absorbed into `set_connection` and `delete_connection` rather than dropped outright: the behaviour survives under the connection vocabulary, and only the plugin-shaped entry points come off the surfaces.

Count: 11 + 10 + 14 + 17 + 13 + 9 + 9 + 7 + 6 = **96** for the full product. The wedge ships 78: the 96 minus the eighteen marked new in the toolbelt, compliance, wrapping, and knowledge families that land from M2 onward and in Series A. Nothing is added back without a row in this appendix.

## Appendix F. The pages that survive

"Survive" here means *stays routed*. The ten pages below are what a user can reach in rev1. The other sixty page files are de-registered, not deleted: each keeps its route only as a redirect, and its `page.tsx`, its components and its `actions.ts` stay in the tree. `DEREGISTERED.md` §3 and §5 name the ones whose capability also came off the surfaces (marketplace, workbench environments); the rest are pages whose capability lives on inside the page that absorbed it.

The current web app has 70 page files. Ten remain: seven at workspace scope, three at organization scope. Sign-in flows (login, signup, password reset, two-factor, verify, accept an invite, create the first organization) are not screens and are not counted; there are seven of them and they stay as they are. Onboarding is not a page: it is the in-app agent's first run inside the workspace.

| # | Page | Route | Absorbs today's routes | Job |
|---|---|---|---|---|
| 1 | **Fleet** | `/{org}/{ws}` | `[ws]` (workspace home), `sessions`, `workbench`, `access/sessions`, `dashboard`, and the approvals queue as a panel | every run, live and recent; pending approvals; pause, resume, cancel |
| 2 | **Run** | `/{org}/{ws}/runs/{run}` | `sessions/*` detail, `knowledge/citations` | frame-by-frame player, cost strip, approvals on this run, steer, fork, bisect, export |
| 3 | **Agents** | `/{org}/{ws}/agents` and `/{run}`-style detail `/{agent}` | `workbench/agents`, `workbench/agents/[agentId]`, `workbench/agents/new`, `workbench/environments`, `settings/agent-defaults`, `developer/mcp` | identity, credentials, roles, toolbelt, mandates, budgets, enrollment |
| 4 | **Tools** | `/{org}/{ws}/tools` | `workbench/tools`, `workbench/tools/agent tools`, `workbench/tools/mcp`, `settings/mcp-server-registries`, `marketplace`, `marketplace/agent-tools`, `marketplace/integrations`, `marketplace/integrations/[connectorId]`, `governance/agent tools`, `governance/policies`, `access/reviews` | registry, connections, mandates ledger, policy versions with simulation, kill switches, assurance results |
| 5 | **Ontology** | `/{org}/{ws}/ontology` | `knowledge`, `knowledge/graph`, `knowledge/graph/[nodeId]`, `knowledge/ontology`, `knowledge/sources`, `knowledge/sources/connect`, `settings/github` | the model map, graph explorer and questions, sources, repositories, versions in git, embedding indexes |
| 6 | **Steering** | `/{org}/{ws}/steering` | `knowledge/memory` | records, proposals, Context PRs, effect, retirement |
| 7 | **Spend** | `/{org}/{ws}/spend` | `settings/spend-budgets`, `billing/usage` | findings, spend by operator and agent, proven spend, reconciliation, budgets |
| 8 | **Organization** | `/{org}` | `[orgSlug]` (org home), `members`, `members/pending`, `workspaces`, `new-workspace`, `settings/general`, `settings/model-funding`, `settings/privacy`, `developer/tokens`, `settings` (workspace general), `settings/general` (workspace) | members and roles, workspaces, model funding and routes, data plane, API keys, workspace settings |
| 9 | **Billing** | `/{org}/billing` | `billing`, `billing/subscription`, `billing/invoices` | plan, run allowance, meters, invoices (linked to Stripe) |
| 10 | **Audit** | `/{org}/audit` | `security`, `security/audit`, `security/compliance`, `security/mfa`, `security/trust`, `governance`, `access` | audit events, incidents, receipts search, legal holds, exports, key rotation, assurance suite results |

Account pages (`account`, `account/profile`, `account/preferences`, `account/privacy`, `account/security`) collapse into one **Account** dialog reachable from the user menu; it is a dialog, not a page. `cli/authorize` and `github/setup` are callback endpoints, not pages, and stay. Every other route in today's list redirects to the page that absorbed it. After one release the **redirect** is removed, not the page file — an unrouted page costs a compile and a test run, and keeping it is what lets a later release put a capability back without rebuilding its screen. Deleting any of these page files takes an ADR that names them (§2.2, `DEREGISTERED.md` §12).

