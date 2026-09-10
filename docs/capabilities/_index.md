# Capabilities

Reference for all declared capabilities across the Oxagen platform.
Each capability is implemented across API, MCP, and agent surfaces with
contract-first design, IAM enforcement, and instrumentation. Following
[ADR-043](../adr/ADR-043-runtime-excision.md), Oxagen is a governance plane —
it does not run agents. Deleted runtime families (sandboxes, code execution,
subagent fan-out, background tasks, file locks, plans, skills, evals,
automations/workflows, browser tools, content generation, research swarm,
web fetch/search, and repo mutations) no longer have capability pages.

**248 capabilities across 35 domains.**

Capabilities granted to an agent as a set have a page of their own:
[the ontology read set](_ontology-read-set.md) covers the graph reads and the
`toolPolicy.ontology` opt-in.

## Agent (57)

- [agent.approval.resolve](agent.approval.resolve.md) — Approve or deny a pending tool-call approval request; resolution ends the tool-call wait and streams the next step
- [agent.debug.trace](agent.debug.trace.md) — Diagnose why an agent execution failed as a structured failure frame: failing step, error class, parsed top stack frames, related spans, and deterministically-ranked suspect files (optional LLM diagnosis via summarize)
- [agent.definition.create](agent.definition.create.md) — Create a new agent definition — inserts the agent identity row (draft, inactive) and an immutable v1 version snapshot with the supplied, schema-validated config
- [agent.definition.delete](agent.definition.delete.md) — Soft-delete an agent definition and its delegated IAM principal together, in one lifecycle
- [agent.definition.get](agent.definition.get.md) — Fetch an agent definition with its active (or latest) version config, parsed and validated
- [agent.definition.list](agent.definition.list.md) — List the agent definitions in the current workspace with identity, lifecycle status, deployment posture, and latest version number
- [agent.definition.publish](agent.definition.publish.md) — Publish an agent version — marks it published, checksums its canonical config, and sets it as the active version (immutable thereafter)
- [agent.definition.suggest](agent.definition.suggest.md) — AI-assisted agent setup — turns a plain-language description into a complete draft agent configuration (identity, instructions, graph access, tools, triggers), grounded in the workspace's real skills, ontologies, MCP servers, and capabilities
- [agent.definition.summarize](agent.definition.summarize.md) — Generate or refresh a short, LLM-inferred plain-text summary of what an agent does, cached against a checksum of its config so it only regenerates when the config changed (or force is set)
- [agent.definition.update](agent.definition.update.md) — Update an agent definition by snapshotting a new unpublished version with the updated config; the version number is bumped
- [agent.deploy](agent.deploy.md) — Set an agent's deployment posture; activating requires a published active version, deactivating makes its triggers dormant
- [agent.environment.bind](agent.environment.bind.md) — Bind an agent to an environment (and optionally a specific sandbox template within it); promoting one to primary atomically demotes the agent's previous primary
- [agent.environment.list](agent.environment.list.md) — List an agent's environment bindings, with each binding's resolved sandbox template name
- [agent.environment.unbind](agent.environment.unbind.md) — Remove an agent's binding to an environment; falls back to the workspace default environment and template when the removed binding was primary
- [agent.execution.list](agent.execution.list.md) — List recent top-level agent runs for the workspace, newest first, with keyset pagination — each row's status, origin, duration, and token/cost figures
- [agent.execution.record](agent.execution.record.md) — Persist a complete agent execution record including steps, tool calls, and result summary for observability and audit
- [agent.mcp.consent.list](agent.mcp.consent.list.md) — List external MCP tool consent grants in the active workspace (which tools the agent may invoke without re-prompting)
- [agent.mcp.consent.resolve](agent.mcp.consent.resolve.md) — Grant or deny first-use consent for an external MCP tool; the decision resumes the paused agent stream and is remembered for subsequent calls
- [agent.mcp.delete](agent.mcp.delete.md) — Soft-delete a registered external MCP server; its tools stop registering immediately while tool-descriptor snapshots are retained for replay
- [agent.mcp.list](agent.mcp.list.md) — List registered external MCP servers in the active workspace with status, transport, auth kind, and tool inventory
- [agent.mcp.register](agent.mcp.register.md) — Register an external MCP server with the workspace; the runner runs a separate process and injects its tools into the agent
- [agent.mcp.set_enabled](agent.mcp.set_enabled.md) — Enable or disable a registered external MCP server; disabling stops its tools from registering but keeps tool-descriptor snapshots for replay
- [agent.mcp_consent.list](agent.mcp_consent.list.md) — List external MCP tool consent grants in the active workspace; scope to the caller with `mineOnly`
- [agent.mcp_consent.resolve](agent.mcp_consent.resolve.md) — Grant or deny first-use consent for an external MCP tool, resuming the paused agent stream
- [agent.memory.citations.list](agent.memory.citations.list.md) — List an execution's memory citations, filterable by compliance (violations) or influence (what shaped output)
- [agent.memory.cite](agent.memory.cite.md) — Record memory citations within an execution (influence + rule compliance); maintains citation/influence/violation counters
- [agent.memory.delete](agent.memory.delete.md) — Permanently delete an AgentMemory node and its edges by id (destructive; prefer update to lower salience)
- [agent.memory.demote](agent.memory.demote.md) — Demote a memory down the confidence ladder (FACT→RULE→OBSERVATION) with an auditable demotion event; clears enforcement on OBSERVATION and human confirmation when leaving FACT
- [agent.memory.evidence.attach](agent.memory.evidence.attach.md) — Attach supporting/refuting evidence to a memory, adjusting confidence and refreshing the decay clock
- [agent.memory.import.commit](agent.memory.import.commit.md) — Write confirmed two-axis draft memories into the workspace AgentMemory Neo4j graph; per-item error capture enables partial success on batch writes
- [agent.memory.import.parse](agent.memory.import.parse.md) — Extract and classify atomic memories (class + kind) from markdown documents using the AI gateway; returns editable drafts without persisting
- [agent.memory.list](agent.memory.list.md) — List a workspace's ACTIVE AgentMemory nodes (newest first) with optional class/kind/enforcement/node filters; non-semantic browse counterpart to agent.memory.recall
- [agent.memory.policy.read](agent.memory.policy.read.md) — Read the workspace memory decay policy: confidence half-lives by weight and the recall threshold
- [agent.memory.policy.write](agent.memory.policy.write.md) — Update the workspace memory decay policy (partial update of half-lives, thresholds, and decay floor)
- [agent.memory.promote](agent.memory.promote.md) — Promote a memory up the confidence ladder (OBSERVATION→RULE→FACT) with an auditable promotion event; FACT requires human confirmation
- [agent.memory.promotion.candidates](agent.memory.promotion.candidates.md) — Top OBSERVATION memories by citation pressure that are candidates for promotion to RULE/FACT
- [agent.memory.recall](agent.memory.recall.md) — Query ACTIVE AgentMemory nodes by semantic similarity with optional class/enforcement filters; recovers confidence on recall
- [agent.memory.remember](agent.memory.remember.md) — Capture a free-text memory, inferring its kind and class unless pinned, then embed and write it to the workspace AgentMemory graph
- [agent.memory.update](agent.memory.update.md) — Edit an AgentMemory in place (lesson, kind, source, confidence/enforcement, status), re-embedding when the lesson changes
- [agent.memory.write](agent.memory.write.md) — Persist a two-axis memory (class + kind, confidence + enforcement) tied to a graph node
- [agent.memory_citation.list](agent.memory_citation.list.md) — List the memory citations recorded for an execution, filterable by compliance or influence
- [agent.memory_citation.stats](agent.memory_citation.stats.md) — Workspace-wide citation analytics across executions: totals, influence/compliance breakdowns, a daily series, and top / least-useful / most-violated memories plus most-cited graph nodes
- [agent.memory_evidence.attach](agent.memory_evidence.attach.md) — Attach corroborating or refuting evidence to a memory and adjust its confidence score
- [agent.memory_import.commit](agent.memory_import.commit.md) — Write confirmed (optionally edited) draft memories into the workspace AgentMemory graph
- [agent.memory_import.parse](agent.memory_import.parse.md) — Extract atomic memories from uploaded documents via the AI gateway, returning editable drafts
- [agent.memory_policy.read](agent.memory_policy.read.md) — Read the workspace memory decay policy: confidence half-lives and recall threshold
- [agent.memory_policy.write](agent.memory_policy.write.md) — Update the workspace memory decay policy (partial update)
- [agent.memory_promotion.dismiss](agent.memory_promotion.dismiss.md) — Dismiss a memory from the promotion-candidate queue (or restore it) so the next candidate fills the slot, without archiving the memory
- [agent.memory_promotion.list](agent.memory_promotion.list.md) — Return the top OBSERVATION memories ripe for promotion to RULE/FACT, ranked by citation pressure
- [agent.memory_promotion.rationales](agent.memory_promotion.rationales.md) — Draft short, context-grounded rationales for a promotion/demotion via a low-cost model, with a deterministic fallback built from citation signals
- [agent.role.assign](agent.role.assign.md) — Assign an IAM role to an agent's delegated principal; system agent roles at every tier, custom roles enterprise-only, rejected when the role's grants exceed the assigner's own effective grants (delegation ceiling)
- [agent.role.get](agent.role.get.md) — Get one IAM role's status relative to an agent: held or not, assignment provenance, and the role's capability grant list
- [agent.role.list](agent.role.list.md) — List the IAM roles attached to an agent's delegated principal with assignment provenance
- [agent.role.revoke](agent.role.revoke.md) — Revoke an IAM role from an agent's delegated principal — soft-deletes the assignment (audit trail preserved); idempotent
- [agent.tool.list](agent.tool.list.md) — List the capabilities surfaced as agent tools for the active workspace, filtered by role, entitlements, and denylist
- [agent.trace.get](agent.trace.get.md) — Fetch one agent execution as a collapsible span tree: the run, its ordered steps, each step's tool calls with durations/tokens/cost/status, and child executions (subagent/A2A lineage)
- [revise_agent_def](revise_agent_def.md) — AI-driven edit of an existing agent definition from a plain-language prompt; the model designs the revised config grounded in the workspace and a new unpublished version is bumped (slug immutable, publish stays separate)

## Api (3)

- [api.key.create](api.key.create.md) — Create a new API key scoped to the requesting org; the raw key is shown once and never retrievable
- [api.key.revoke](api.key.revoke.md) — Revoke an API key by its public ID; the key is soft-deleted and immediately invalid for all subsequent requests
- [api.key.rotate](api.key.rotate.md) — Atomically issue a replacement API key and revoke the old one; the new raw key is shown once

## Asset (1)

- [asset.upload](asset.upload.md) — Ingest a binary asset from a publicly reachable source URL into object storage

## Audit (1)

- [audit.log.query](audit.log.query.md) — Query the org's security and automation audit events with structured filters, newest-first

## Billing (22)

- [billing.budget.get](billing.budget.get.md) — Read the hard period-to-date spend ceilings (org + workspace) governing the active scope, each with live burn: period-to-date spend, projection, percent-of-ceiling, and whether the gate is denying
- [billing.budget.set](billing.budget.set.md) — Create or replace one scope's hard period-to-date spend ceiling (org or workspace; monthly or rolling window; USD limit). Raising a ceiling is the audited org-admin override that clears a budget_exceeded denial. Owner/Admin/Billing only
- [billing.credits.purchase](billing.credits.purchase.md) — Initiate a dynamic usage-credit purchase via Stripe Checkout with automatic volume discount
- [billing.subscription.read](billing.subscription.read.md) — Return the active subscription, plan slug, current period bounds, and available credits
- [billing.subscription.upgrade.start](billing.subscription.upgrade.start.md) — Begin a plan change via Stripe Checkout; returns a URL for the user to complete
- [billing.subscription_upgrade.start](billing.subscription_upgrade.start.md) — Begin a plan change; returns a Stripe Checkout URL, completed via webhook
- [billing.usage.breakdown](billing.usage.breakdown.md) — Aggregated usage (tokens, cost, calls) for a window, broken down by model, surface, and workspace, plus a daily time series

## Budget (2)

- [budget.policy.read](budget.policy.read.md) — Read the calling user's saved per-turn dollar budget (enabled, limit, enforcement mode, grace cushion)
- [budget.policy.write](budget.policy.write.md) — Update the calling user's saved per-turn dollar budget (partial update): on/off, USD limit, mode (grace/prompt/enforce), grace cushion

## Capability (2)

- [capability.registry.get](capability.registry.get.md) — Read one typed contract as the full enforced object: identity grants, tenancy scope, input/output field specs, commercial terms, and chaining metadata
- [capability.registry.list](capability.registry.list.md) — List the platform's typed capability contracts from the live in-process registry (name, domain, surfaces, layers, sensitivity, default IAM grants, entitlement gate, audit binding); the governance catalog's data source

## Chat (2)

- [chat.message.execution](chat.message.execution.md) — Record an agent execution that originated from a chat message; atomically links execution to message for observability
- [chat.message.send](chat.message.send.md) — Append a user message to a conversation and stream the assistant's response

## Command (2)

- [command.menu.search](command.menu.search.md) — Full-text entity search for the Command Menu, returning up to 8 typed, ready-to-navigate rows filtered to the caller's grants
- [command.menu.suggest](command.menu.suggest.md) — Generate 3–5 context-aware "Suggested for this page" prompts via a fast LLM tier, sending only the page entity summary

## Connection (10)

- [connection.create](connection.create.md) — Create a new data source connection for a workspace; credentials are encrypted before storage
- [connection.delete](connection.delete.md) — Delete a data source connection with three modes: connection_only, data_only, or full deletion
- [connection.get](connection.get.md) — Get details of a single data source connection
- [connection.list](connection.list.md) — List all data source connections for a workspace
- [connection.mappings.get](connection.mappings.get.md) — Get the current entity type mappings for a data source connection
- [connection.mappings.set](connection.mappings.set.md) — Save entity type mappings for a data source connection; activates connection and starts ingestion
- [connection.mappings.suggest](connection.mappings.suggest.md) — Use an LLM to suggest entity type mappings based on previewed record types
- [connection.pause](connection.pause.md) — Pause or resume syncing for a connection without tearing down the connection or its data
- [connection.preview](connection.preview.md) — Preview sample records from a data source connection for the setup wizard
- [connection.update](connection.update.md) — Rename a connection and/or adjust its delivery configuration (sync schedule/scope)

## Context (3)

- [context.record.list](context.record.list.md) — List the steering context records registered in the active workspace with lifecycle status
- [context.record.promote](context.record.promote.md) — Append a lifecycle action to a context record's hash-chained promotions ledger
- [context.record.publish](context.record.publish.md) — Publish a steering context record into the workspace agent-asset registry

## Conversation (9)

- [conversation.archive](conversation.archive.md) — Archive or restore one or more conversations in a single set-based update
- [conversation.attachment.add](conversation.attachment.add.md) — Link an already-uploaded asset to a conversation as a chat attachment and return its conversation-file record
- [conversation.chat](conversation.chat.md) — Post a message to an existing conversation; appends to the conversation thread
- [conversation.delete](conversation.delete.md) — Permanently delete one or more conversations from the user's view via soft-delete
- [conversation.export](conversation.export.md) — Export an entire conversation (active branch) as a Markdown document or a formatted PDF
- [conversation.files.list](conversation.files.list.md) — List the ready generated assets attached to a conversation, access-policy filtered, newest-first, keyset-paginated
- [conversation.list](conversation.list.md) — List a user's conversations in a workspace, filtered by active or archived status
- [conversation.purge](conversation.purge.md) — Bulk soft-delete every archived conversation the caller owns in the active workspace
- [conversation.rename](conversation.rename.md) — Set a conversation's title; low-risk metadata edit exposed via long-press or double-click

## Environment (6)

- [environment.create](environment.create.md) — Create a workspace environment (e.g. production, development, preview) for scoping secrets and sandbox config
- [environment.delete](environment.delete.md) — Soft-delete a workspace environment; the default cannot be deleted until another is promoted
- [environment.get](environment.get.md) — Fetch a single workspace environment by its public id
- [environment.list](environment.list.md) — List the environments configured in the active workspace
- [environment.set_default](environment.set_default.md) — Promote an environment to the workspace default via an atomic swap
- [environment.update](environment.update.md) — Update a workspace environment's name, slug, description, or active state; the default cannot be deactivated

## Graph (7)

- [graph.node.get](graph.node.get.md) — Retrieve a single `KnowledgeNode` from the workspace graph by its `publicId`
- [graph.node.labels.get](graph.node.labels.get.md) — Renamed to `graph.node_label.get` (ADR-022 alias)
- [graph.node.list](graph.node.list.md) — Paginated browse of all nodes in the workspace graph; backs the graph explorer UI
- [graph.node.search](graph.node.search.md) — Text search over the workspace graph, matching `displayName`/`description` with optional label filter
- [graph.node_label.get](graph.node_label.get.md) — Read a node's full label set; read-only companion to label add/remove
- [graph.search](graph.search.md) — Natural-language semantic search across eligible shared workspace knowledge, ranked by vector similarity
- [graph.stats](graph.stats.md) — Workspace graph statistics: node count, edge count, inferred edge count, breakdown by type

## Iam (1)

- [iam.role.list](iam.role.list.md) — List the org's IAM roles with capability grants and active assignment counts; read-only (writes remain provisioning-script-only)

## Integration (7)

- [integration.configure](integration.configure.md) — Update plugin instance configuration, filters, and sync cadence
- [integration.delete](integration.delete.md) — Remove a plugin instance and optionally purge graph data (async)
- [integration.get](integration.get.md) — Get full details of a single plugin instance including schema
- [integration.install](integration.install.md) — Install a plugin instance from catalog or custom URL (async)
- [integration.list](integration.list.md) — Browse installed plugin instances with status and sync metrics
- [integration.metrics](integration.metrics.md) — Get sync statistics and metrics for a plugin instance
- [integration.sync](integration.sync.md) — Trigger synchronization of a plugin instance (async)

## Model (1)

- [model.capability.list](model.capability.list.md) — List the provider capability posture matrix — per vendor, how its prompt cache is engaged (explicit opt-in vs implicit), how its reasoning budget is controlled, how structured output is obtained, and which attachment kinds it accepts

## Notification (2)

- [notification.list](notification.list.md) — List in-app notifications for the calling user, with unread filtering and pagination
- [notification.mark](notification.mark.md) — Mark a notification as read and/or archived for the calling user

## Notifications (2)

- [notifications.list](notifications.list.md) — List in-app notifications for the calling user with unread filtering and pagination
- [notifications.mark](notifications.mark.md) — Mark a notification as read and/or archived for the calling user

## Ontology (2)

- [ontology.neighbors](ontology.neighbors.md) — The one-hop neighborhood of a node — a focused traversal primitive pairing with `ontology.query`
- [ontology.query](ontology.query.md) — Typed multi-hop traversal over the knowledge graph via a governed, non-Cypher shape

## Org (14)

- [org.create](org.create.md) — Create a new organization with a globally-unique slug and attach the caller as first member
- [get_data_plane](get_data_plane.md) — Read the organisation's data-plane binding for one store (postgres/neo4j/clickhouse): shared or dedicated, health status, endpoint host and database name — never a credential
- [set_data_plane](set_data_plane.md) — Bind one of the organisation's stores to a dedicated customer-controlled endpoint, or return it to the shared platform plane; the config is envelope-encrypted and never readable back
- [org.list](org.list.md) — List the organizations the authenticated user belongs to, with the caller's role in each; backs the CLI tenant picker
- [org.member.add](org.member.add.md) — Invite a user to join the org by email; enforces seat limits
- [org.member.invite.accept](org.member.invite.accept.md) — Accept a pending org invitation; creates membership and provisions IAM
- [org.member.invite.decline](org.member.invite.decline.md) — Decline a pending org invitation; frees the reserved license seat
- [org.member.remove](org.member.remove.md) — Permanently remove a member from the org; irreversible action with last-owner block
- [org.member.role.change](org.member.role.change.md) — Change a member's org role; blocks last-owner demotion
- [org.member_invite.accept](org.member_invite.accept.md) — Accept a pending org invitation and provision least-privilege IAM for the user
- [org.member_invite.decline](org.member_invite.decline.md) — Decline a pending org invitation and free the reserved license seat
- [org.member_role.change](org.member_role.change.md) — Change a member's org role; blocks demoting the last org owner
- [org.settings.read](org.settings.read.md) — Read the org's profile settings: name, slug, avatar, website, industry, employee size, type
- [org.settings.write](org.settings.write.md) — Update the org's profile settings (partial) through the kernel with IAM, metering, and audit

## Organization (1)

- [organization.create](organization.create.md) — Create a new organization with a globally-unique slug

## Plugin (19)

- [plugin.catalog.browse](plugin.catalog.browse.md) — Search and filter the MCP server catalog by text, category, transport, and auth kind
- [plugin.catalog.get](plugin.catalog.get.md) — Get full detail for one catalog server entry including README, packages, and transport types
- [plugin.catalog.sync](plugin.catalog.sync.md) — Trigger an immediate sync of the MCP registry catalog for the workspace, refreshing cached server listings from the upstream registry
- [plugin.credential.reauth](plugin.credential.reauth.md) — Initiate or complete an OAuth re-authentication flow for an expired plugin token
- [plugin.credential.revoke](plugin.credential.revoke.md) — Revoke and delete the stored credential for an installed plugin so the workspace must re-authenticate
- [plugin.credential.set_secret](plugin.credential.set_secret.md) — Store or update an encrypted credential (API key or bearer token) for a plugin server
- [plugin.org.install](plugin.org.install.md) — Install a catalog or custom server to the org allow-list; disabled by default
- [plugin.org.install_bulk](plugin.org.install_bulk.md) — Install multiple catalog or custom plugin servers to the org allow-list in one request
- [plugin.org.list](plugin.org.list.md) — List installed plugins and denylisted server names for the org with enabled/disabled status
- [plugin.org.uninstall](plugin.org.uninstall.md) — Soft-delete a plugin listing from the org allow-list and remove dependent workspace installs
- [plugin.registry.add](plugin.registry.add.md) — Add a custom MCP registry source for the org; triggers automatic catalog sync
- [plugin.registry.list](plugin.registry.list.md) — List MCP registries available to the org including the default seed registry
- [plugin.registry.remove](plugin.registry.remove.md) — Remove an org-added MCP registry source; the default registry cannot be removed
- [plugin.schema.get](plugin.schema.get.md) — Fetch typed config schema for a connector plugin
- [plugin.schema.validate](plugin.schema.validate.md) — Validate a config object against a plugin schema
- [plugin.set_enabled](plugin.set_enabled.md) — Enable/disable a plugin listing; scope='org' toggles the org listing flag, scope='workspace' upserts/disables the workspace mcp_servers row
- [plugin.settings.get_auth_alerts](plugin.settings.get_auth_alerts.md) — Read the org's MCP auth-alert notification setting (roles + email toggle), with the documented default when unset
- [plugin.settings.set_auth_alerts](plugin.settings.set_auth_alerts.md) — Configure re-authentication alert preferences for the org
- [plugin.version.list](plugin.version.list.md) — List version history with changelog and breaking-change flags

## Privacy (2)

- [privacy.data.erase](privacy.data.erase.md) — Request erasure of personal or organizational data under GDPR Article 17
- [privacy.data.export](privacy.data.export.md) — Request a machine-readable ZIP archive of data under GDPR Article 20

## Prompt (2)

- [prompt.settings.read](prompt.settings.read.md) — Read the workspace prompt configuration including appended instructions and auto-improve toggle
- [prompt.settings.write](prompt.settings.write.md) — Update the workspace prompt configuration (partial update)

## Reference (2)

- [reference.cite](reference.cite.md) — Record @-mention citations of knowledge-graph nodes within a chat execution, creating :Citation lineage and incrementing citation counters
- [reference.search](reference.search.md) — Tenant-scoped autocomplete search across every referenceable platform object (repositories, branches, files, directories, agents, skills, tools, MCP servers, capabilities, nodes, edges) for the chat @-mention picker

## Repo (8)

- [repo.ci.status](repo.ci.status.md) — Read CI check-run and commit-status results for a ref in a GitHub repository
- [repo.configure](repo.configure.md) — Set repo-specific config: filters, inference, cadence, field mappings
- [repo.metrics](repo.metrics.md) — Get sync statistics and metrics for a repository connection
- [repo.pause](repo.pause.md) — Pause automatic syncing for a repository connection
- [repo.pr.diff](repo.pr.diff.md) — Read the per-file unified-diff patches for a GitHub pull request
- [repo.pr.get](repo.pr.get.md) — Read a GitHub pull request's summary, diff stats, comments, and CI status
- [repo.resume](repo.resume.md) — Resume automatic syncing for a paused repository connection
- [repo.sync](repo.sync.md) — Trigger incremental or full re-index of a repository connection (async)

## Router (4)

- [router.decision.preview](router.decision.preview.md) — Dry-run the market router for a prompt: task class, observed outcomes, and the full decision (chosen model + candidate audit trail); changes nothing
- [router.policy.get](router.policy.get.md) — Read the effective market-router policy for the current scope (mode, threshold, samples, window, escalation) plus its provenance (workspace / org / default)
- [router.policy.set](router.policy.set.md) — Set the market-router policy for this org or workspace (partial update) — mode, thresholds, and tier-escalation; changes model spend behavior, Owner/Admin only
- [router.stats.list](router.stats.list.md) — List observed outcomes per (task class, model) — samples, verified rate, cost, latency — plus the cheapest model currently clearing the bar per class

## Schema (23)

- [schema.chat](schema.chat.md) — AI iterative builder turn: takes conversation and draft, returns assistant message and proposed mutations
- [schema.delete](schema.delete.md) — Drop an entire named schema from the draft, removing its labels, relationship types, and properties
- [schema.export](schema.export.md) — Export a schema version as a downloadable ZIP grouped by schema
- [schema.label.delete](schema.label.delete.md) — Remove a node label and all its properties from the current draft
- [schema.label.upsert](schema.label.upsert.md) — Create or update a node label on a schema within the current draft version
- [schema.list](schema.list.md) — List workspace schemas with per-schema enabled state (lightweight listing without full tree)
- [schema.property.delete](schema.property.delete.md) — Remove a property from the current draft
- [schema.property.upsert](schema.property.upsert.md) — Create or update a property on a node label or relationship type in the current draft
- [schema.recommend](schema.recommend.md) — AI-generated schema recommendation based on existing graph structure and observed labels
- [schema.reconcile.dispatch](schema.reconcile.dispatch.md) — Dispatch an async job to re-label existing graph nodes and relationships against the pinned schema version
- [schema.reconcile.status](schema.reconcile.status.md) — Poll the progress and outcome of a schema reconciliation job
- [schema.registry.config](schema.registry.config.md) — Set enforcement mode and conformance floor for the workspace schema registry
- [schema.registry.get](schema.registry.get.md) — Resolve the workspace registry: pinned version, enforcement mode, and the full label/relationship/property tree
- [schema.relationship.delete](schema.relationship.delete.md) — Remove a relationship type from the current draft
- [schema.relationship.upsert](schema.relationship.upsert.md) — Create or update a relationship type on a schema within the current draft version
- [schema.setup](schema.setup.md) — Interactive LLM-assisted schema setup wizard: recommend → Q&A → apply → activate
- [schema.toggle](schema.toggle.md) — Enable/disable a schema; activation auto-publishes the draft and pins the resulting version
- [schema.validate.node](schema.validate.node.md) — Validate a node's properties against the workspace schema; returns conformance score and field errors
- [schema.validate.relationship](schema.validate.relationship.md) — Validate a relationship's type and properties against the workspace schema
- [schema.version.create](schema.version.create.md) — Freeze the current draft into an immutable published version and open a fresh draft
- [schema.version.diff](schema.version.diff.md) — Structural diff of two schema versions: added/removed/changed schemas, labels, types, and properties
- [schema.version.list](schema.version.list.md) — List all schema versions with status, label, and change summary
- [schema.version.pin](schema.version.pin.md) — Pin the workspace to a specific published schema version

## Secret (8)

- [secret.export](secret.export.md) — Export an environment's resolved secret set as decrypted key/value pairs and .env text; Owner/Admin only, every export is audited (api, mcp)
- [secret.import_env](secret.import_env.md) — Parse pasted .env text and preview/commit key upserts + value sets for the defaults or a chosen environment
- [secret.key.delete](secret.key.delete.md) — Soft-delete a vault secret key and hard-remove all of its per-environment overrides
- [secret.key.list](secret.key.list.md) — List vault secret keys with masked metadata; never returns plaintext values
- [secret.key.upsert](secret.key.upsert.md) — Create or update a vault secret key at the workspace root; sensitive keys are envelope-encrypted, with an optional default value
- [secret.reveal](secret.reveal.md) — Reveal a single secret's plaintext value for an environment; Owner/Admin only, every reveal is audited (api, mcp)
- [secret.value.set](secret.value.set.md) — Set a secret's value override for a specific environment, encrypted or plaintext per the key's sensitive flag
- [secret.value.unset](secret.value.unset.md) — Remove a secret's per-environment override so it falls back to the key's default value

## System (1)

- [system.install.instructions](system.install.instructions.md) — Return ordered, copy-ready MCP/CLI installation instructions per client

## Tacho (9)

- [tacho.bundle.get](tacho.bundle.get.md) — The signed policy bundle a host caches and evaluates locally (docs/specs/tacho/spec
- [tacho.command.dispatch](tacho.command.dispatch.md) — Queue a control command for a host or one of its sessions (docs/specs/tacho/spec
- [tacho.command.fetch](tacho.command.fetch.md) — The idle-host control poll: acknowledge the outcomes of commands the collector applied, and receive pending ones together with the same control envelope every ingest carries
- [tacho.enrollment.create](tacho.enrollment.create.md) — Enrol a machine as a Tacho host (docs/specs/tacho/spec
- [tacho.enrollment.revoke](tacho.enrollment.revoke.md) — Revoke a Tacho host
- [tacho.events.ingest](tacho.events.ingest.md) — Ingest a batch of hash-chained tacho/1
- [tacho.host.list](tacho.host.list.md) — List the machines enrolled as Tacho hosts in this workspace, newest first, with status, mode, harness and version facts, liveness (last seen, last ingest, hooks and OpenTelemetry health, spool depth), and counters (sessions, unobserved sessions, open incidents)
- [tacho.session.get](tacho.session.get.md) — One session's flight-recorder index (docs/specs/tacho/data-model
- [tacho.session.list](tacho.session.list.md) — List Tacho sessions in this workspace, newest first

## Telemetry (2)

- [telemetry.error.cluster](telemetry.error.cluster.md) — Cluster recent captured errors by fingerprint to see which error classes are recurring and how often across the org — the triage overview
- [telemetry.stella.ingest](telemetry.stella.ingest.md) — Ingest an authenticated, content-free batch of Stella operational execution rollups for an explicitly enrolled Enterprise workspace

## Tool (2)

- [tool.declaration.list](tool.declaration.list.md) — List the tool declarations registered in the active workspace with their pinned version facts
- [tool.declaration.publish](tool.declaration.publish.md) — Publish a tool declaration into the workspace agent-asset registry, versioned and idempotent

## User (4)

- [get_workspace_user_preferences](get_workspace_user_preferences.md) — Read the calling user's per-workspace coding-agent defaults: default repo connection/slug, default environment, and whether the one-time repo-default prompt has been shown
- [update_workspace_user_preferences](update_workspace_user_preferences.md) — Update the calling user's per-workspace coding-agent defaults (partial update); app-only surface
- [user.preferences.read](user.preferences.read.md) — Read the calling user's UI and model preferences
- [user.preferences.write](user.preferences.write.md) — Update the calling user's UI and model preferences (partial update)

## Workspace (14)

- [workspace.budget.policy.read](workspace.budget.policy.read.md) — Read the workspace's governed per-turn dollar budget: whether enforcement is active, the limit in USD, enforcement mode (grace/prompt/enforce), grace cushion, and enforcement policy (ceiling/default)
- [workspace.budget.policy.write](workspace.budget.policy.write.md) — Set the workspace's governed per-turn dollar budget (partial update); Owner/Admin only; controls how agent turns are budget-governed for members
- [workspace.budget_policy.read](workspace.budget_policy.read.md) — Read the workspace's governed per-turn dollar budget and enforcement mode
- [workspace.budget_policy.write](workspace.budget_policy.write.md) — Set the workspace's governed per-turn dollar budget (partial update); Owner/Admin only
- [workspace.create](workspace.create.md) — Create a workspace inside the caller's active tenant
- [workspace.invite.send](workspace.invite.send.md) — Send a workspace invitation to an email address with 7-day expiry
- [workspace.list](workspace.list.md) — List the workspaces inside an organization the caller belongs to; backs the CLI workspace picker in oxagen init
- [workspace.member.list](workspace.member.list.md) — List members of a workspace
- [workspace.model.settings.read](workspace.model.settings.read.md) — Read the workspace-level model defaults
- [workspace.model.settings.write](workspace.model.settings.write.md) — Update the workspace-level model defaults (partial update)
- [workspace.model_settings.read](workspace.model_settings.read.md) — Read the workspace-level model defaults for text/image/video tiers
- [workspace.model_settings.write](workspace.model_settings.write.md) — Update the workspace-level model defaults (partial update); Owner/Admin only
- [workspace.settings.read](workspace.settings.read.md) — Read the workspace's general settings: name, slug, description
- [workspace.settings.write](workspace.settings.write.md) — Update the workspace's general settings (partial) through the kernel with IAM, metering, and audit

## Partner connectors

Oxagen supports both built-in connectors (GitHub, Google Drive, Slack, Linear)
and partner-authored connectors loaded from a hosted `schema.yaml` URL.

Partner schemas follow the same `ConnectorPlugin` format as built-in schemas.
The platform fetches, validates, and caches partner schemas transparently —
the `plugin.schema.get` and `integration.install` capabilities handle both
paths without separate APIs.

| Resource                                                      | Description                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Connector Authoring Guide](../guides/connector-authoring.md) | How to author a `schema.yaml` for a partner connector — schema sections, field widgets, validation patterns, AI prompt best practices, and testing. |
| [Partner Registration](../guides/partner-registration.md)     | Registration workflow, marketplace listing requirements, security checklist, and support SLA.                                                       |
| `packages/ingestion/src/connectors/example-saas/schema.yaml`  | Fully annotated reference schema demonstrating every section and field type.                                                                        |

To install a partner connector by schema URL:

```bash
oxagen integrations install \
  --plugin-id my-platform \
  --schema-url https://cdn.mycompany.com/oxagen/schema.yaml \
  --display-name "My Platform" \
  --config '{"accountId":"acme"}'
```
