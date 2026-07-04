# Capabilities

Reference for all declared capabilities across the Oxagen platform.
Each capability is implemented across API, MCP, and agent surfaces with
contract-first design, IAM enforcement, and instrumentation.

## Agent (26)

- [agent.approval.resolve](agent.approval.resolve.md) — Approve or deny a pending tool-call approval request; resolution ends the tool-call wait and streams the next step
- [agent.code.execute](agent.code.execute.md) — Execute a code snippet in an isolated sandbox and return the exit code, stdout, stderr, and execution time
- [agent.compose](agent.compose.md) — Plan and execute a chain of capabilities to accomplish a goal, threading each step's output into dependent inputs, then synthesize a summary
- [agent.execution.record](agent.execution.record.md) — Persist a complete agent execution record including steps, tool calls, and result summary for observability and audit
- [agent.feature.verify](agent.feature.verify.md) — Independent cross-LLM judge: a DIFFERENT vision model than the builder reads screenshots of a feature and returns a pass/fail verdict against the stated requirement. The proof-of-done gate.
- [agent.mcp.consent.list](agent.mcp.consent.list.md) — List external MCP tool consent grants in the active workspace (which tools the agent may invoke without re-prompting)
- [agent.mcp.consent.resolve](agent.mcp.consent.resolve.md) — Grant or deny first-use consent for an external MCP tool; the decision resumes the paused agent stream and is remembered for subsequent calls
- [agent.mcp.delete](agent.mcp.delete.md) — Soft-delete a registered external MCP server; its tools stop registering immediately while tool-descriptor snapshots are retained for replay
- [agent.mcp.list](agent.mcp.list.md) — List registered external MCP servers in the active workspace with status, transport, auth kind, and tool inventory
- [agent.mcp.register](agent.mcp.register.md) — Register an external MCP server with the workspace; the runner runs a separate process and injects its tools into the agent
- [agent.mcp.set_enabled](agent.mcp.set_enabled.md) — Enable or disable a registered external MCP server; disabling stops its tools from registering but keeps tool-descriptor snapshots for replay
- [agent.memory.cite](agent.memory.cite.md) — Record memory citations within an execution (influence + rule compliance); maintains citation/influence/violation counters
- [agent.memory.citations.list](agent.memory.citations.list.md) — List an execution's memory citations, filterable by compliance (violations) or influence (what shaped output)
- [agent.memory.evidence.attach](agent.memory.evidence.attach.md) — Attach supporting/refuting evidence to a memory, adjusting confidence and refreshing the decay clock
- [agent.memory.import.commit](agent.memory.import.commit.md) — Write confirmed two-axis draft memories into the workspace AgentMemory Neo4j graph; per-item error capture enables partial success on batch writes
- [agent.memory.import.parse](agent.memory.import.parse.md) — Extract and classify atomic memories (class + kind) from markdown documents using the AI gateway; returns editable drafts without persisting
- [agent.memory.list](agent.memory.list.md) — List a workspace's ACTIVE AgentMemory nodes (newest first) with optional class/kind/enforcement/node filters; non-semantic browse counterpart to agent.memory.recall
- [agent.memory.promote](agent.memory.promote.md) — Promote a memory up the confidence ladder (OBSERVATION→RULE→FACT) with an auditable promotion event; FACT requires human confirmation
- [agent.memory.promotion.candidates](agent.memory.promotion.candidates.md) — Top OBSERVATION memories by citation pressure that are candidates for promotion to RULE/FACT
- [agent.memory.recall](agent.memory.recall.md) — Query ACTIVE AgentMemory nodes by semantic similarity with optional class/enforcement filters; recovers confidence on recall
- [agent.memory.write](agent.memory.write.md) — Persist a two-axis memory (class + kind, confidence + enforcement) tied to a graph node
- [agent.plan.approve](agent.plan.approve.md) — Approve, deny, or amend a previously-proposed plan; approval releases the agent stream to execute the plan's side-effectful steps
- [agent.plan.create](agent.plan.create.md) — Create a structured hierarchical execution plan with tasks, dependencies, and approval gates; approval via agent.plan.approve is required before execution
- [agent.sandbox.exec](agent.sandbox.exec.md) — Run a shell command inside a durable sandbox session; filesystem/process state persists across calls; returns stdout, stderr, exit code
- [agent.sandbox.files.list](agent.sandbox.files.list.md) — List files and directories inside a durable sandbox session's workspace
- [agent.sandbox.snapshot](agent.sandbox.snapshot.md) — Capture a filesystem snapshot of a durable sandbox session so it can be restored after an idle reap or the 24h lifetime ceiling
- [agent.sandbox.start](agent.sandbox.start.md) — Provision or reconnect to a durable code-agent sandbox that persists across turns; pass a stable sessionKey to reuse one warm sandbox
- [agent.sandbox.stop](agent.sandbox.stop.md) — Terminate a durable sandbox session and release its resources; call when the work is finished
- [agent.skill.list](agent.skill.list.md) — List skills available in the active workspace including built-in filesystem and dynamic marketplace-installed skills
- [agent.skill.load](agent.skill.load.md) — Load and register a workspace skill at runtime, resolving the requested version and parsing its configuration
- [agent.subagent.aggregate](agent.subagent.aggregate.md) — Wait for all child runs in a subagent fanout to complete and return merged results, conflict list, and execution timeline
- [agent.subagent.cancel](agent.subagent.cancel.md) — Cancel an in-progress subagent fan-out; transitions the fanout and all non-terminal child runs to a terminal status
- [agent.subagent.dispatch](agent.subagent.dispatch.md) — Fan out a set of tasks to multiple subagents running in parallel; returns a dispatchId to poll via agent.subagent.aggregate
- [agent.subagent.logs](agent.subagent.logs.md) — Generate a downloadable markdown logfile for a fan-out, traceable down to each subagent's query and individual results
- [agent.subagent.result.get](agent.subagent.result.get.md) — Fetch one subagent child run's full input + output by runId; the on-demand counterpart to compact agent.subagent.aggregate
- [agent.subagent.siblings](agent.subagent.siblings.md) — Given a running fanout child's runId, return its siblings as compact rows (capability, status, summary, attempts) so it can see what siblings already covered before burning tokens
- [agent.task.background.cancel](agent.task.background.cancel.md) — Cancel a running background task; downstream Inngest steps stop on cancellation
- [agent.task.background.read](agent.task.background.read.md) — Read the current status, progress markers, and final result of a background task
- [agent.task.background.start](agent.task.background.start.md) — Dispatch a long-running task as a durable Inngest job; the chat stream polls for status
- [agent.tool.list](agent.tool.list.md) — List the capabilities surfaced as agent tools for the active workspace, filtered by role, entitlements, and denylist
- [agent.ui.render](agent.ui.render.md) — Render a structured UI component from an agent response; the client maps the component type to a React renderer

## Api (3)

- [api.key.create](api.key.create.md) — Create a new API key scoped to the requesting org; the raw key is shown once and never retrievable
- [api.key.revoke](api.key.revoke.md) — Revoke an API key by its public ID; the key is soft-deleted and immediately invalid for all subsequent requests
- [api.key.rotate](api.key.rotate.md) — Atomically issue a replacement API key and revoke the old one; the new raw key is shown once

## Archive (1)

- [archive.create](archive.create.md) — Bundle one or more items into a ZIP archive and upload to storage; returns a file-attachment render directive

## Asset (1)

- [asset.upload](asset.upload.md) — Ingest a binary asset from a publicly reachable source URL into object storage

## Automation (6)

- [automation.create](automation.create.md) — Create a playbook and trigger for an automation with configurable trigger type (event, schedule, or manual)
- [automation.update](automation.update.md) — Edit an existing automation: rename, change description, or replace the trigger configuration
- [automation.disable](automation.disable.md) — Disable an automation trigger so it stops firing; safe to call without approval
- [automation.enable](automation.enable.md) — Enable an automation trigger so it fires live; the only path from configured to live, gated by human approval
- [automation.list](automation.list.md) — List automation rules in the caller's active workspace, ordered by creation date descending
- [automation.trigger](automation.trigger.md) — Manually trigger an automation by ID with an optional payload; creates a run record

## Audit (1)

| Capability        | Notes                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| `audit.log.query` | Query security + automation audit spines (org-scoped); admin-only, read-only. |

## Billing (3)

- [billing.credits.purchase](billing.credits.purchase.md) — Initiate a dynamic usage-credit purchase via Stripe Checkout with automatic volume discount
- [billing.subscription.read](billing.subscription.read.md) — Return the active subscription, plan slug, current period bounds, and available credits
- [billing.subscription.upgrade.start](billing.subscription.upgrade.start.md) — Begin a plan change via Stripe Checkout; returns a URL for the user to complete
- [billing.usage.breakdown](billing.usage.breakdown.md) — Aggregated usage (tokens, cost, calls) for a window, broken down by model, surface, and workspace, plus a daily time series

## Browser (7)

- [browser.click](browser.click.md) — Click an element (by CSS selector) on the durable sandbox browser's current page; Playwright auto-waits for the element to be actionable
- [browser.fill](browser.fill.md) — Fill a form field (by CSS selector) on the durable sandbox browser's current page; state persists so a later submit acts on the filled value
- [browser.navigate](browser.navigate.md) — Navigate the durable sandbox's browser to a URL and wait for load; use to prove a feature renders at a given URL inside the sandbox
- [browser.read](browser.read.md) — Read visible text from the durable sandbox browser's current page (whole page or a CSS-selected element) for programmatic assertions
- [browser.refresh](browser.refresh.md) — Reload the durable sandbox browser's current page and wait for load; useful after a rebuild or HMR update to re-check a feature
- [browser.screenshot](browser.screenshot.md) — Screenshot the durable sandbox browser's current page or element and store it as a private workspace asset for the cross-LLM judge
- [browser.submit](browser.submit.md) — Submit a form on the durable sandbox browser's current page (click the given selector, or press Enter) and wait for the result to settle

## Chat (2)

- [chat.message.execution](chat.message.execution.md) — Record an agent execution that originated from a chat message; atomically links execution to message for observability
- [chat.message.send](chat.message.send.md) — Append a user message to a conversation and stream the assistant's response

## Code (4)

- [code.diff](code.diff.md) — Produce a unified diff between two file blobs with added/removed line counts (computed in-process)
- [code.format](code.format.md) — Run a language-aware formatter (json, python) on source inside the sandbox and return the formatted text
- [code.map](code.map.md) — Return a structured code-map bundle for a natural-language concept query: semantically matched files, symbols, call edges, and recent commits
- [code.patch](code.patch.md) — Apply a unified diff to a path-confined workspace and return only the changed files

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

## Conversation (7)

- [conversation.archive](conversation.archive.md) — Archive or restore one or more conversations in a single set-based update
- [conversation.chat](conversation.chat.md) — Post a message to an existing conversation; appends to the conversation thread
- [conversation.attachment.add](conversation.attachment.add.md) — Link an already-uploaded asset to a conversation as a chat attachment and return its conversation-file record
- [conversation.delete](conversation.delete.md) — Permanently delete one or more conversations from the user's view via soft-delete
- [conversation.files.list](conversation.files.list.md) — List the ready generated assets attached to a conversation, access-policy filtered, newest-first, keyset-paginated
- [conversation.list](conversation.list.md) — List a user's conversations in a workspace, filtered by active or archived status
- [conversation.purge](conversation.purge.md) — Bulk soft-delete every archived conversation the caller owns in the active workspace
- [conversation.rename](conversation.rename.md) — Set a conversation's title; low-risk metadata edit exposed via long-press or double-click

## Document (3)

- [document.create](document.create.md) — Create a new document in the workspace
- [document.list](document.list.md) — List documents in the workspace
- [document.read](document.read.md) — Read a document by ID; returns title, content, and metadata

## Documents (3)

- [documents.generate](documents.generate.md) — Generate a new document, spreadsheet, or presentation in a cloud provider (stub)
- [documents.pdf.create](documents.pdf.create.md) — Render a PDF from either raw HTML or an existing cloud file (stub)
- [markdown.generate](markdown.generate.md) — Persist a Markdown document as a first-class generated asset (blob storage, file-attachment render directive)

## Environment (6)

- [environment.create](environment.create.md) — Create a workspace environment (e.g. production, development, preview) for scoping secrets and sandbox config
- [environment.list](environment.list.md) — List the environments configured in the active workspace
- [environment.get](environment.get.md) — Fetch a single workspace environment by its public id
- [environment.update](environment.update.md) — Update a workspace environment's name, slug, description, or active state; the default cannot be deactivated
- [environment.delete](environment.delete.md) — Soft-delete a workspace environment; the default cannot be deleted until another is promoted
- [environment.set_default](environment.set_default.md) — Promote an environment to the workspace default via an atomic swap

## Form (1)

- [form.fill](form.fill.md) — Generatively fill or suggest values for page-level form fields based on context

## Graph (13)

| Capability                  | Notes                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph.node.list`           | Paginated browse of all nodes in the workspace graph.                                                                                                     |
| `graph.node.upsert`         | Create or update a graph node by externalId.                                                                                                              |
| `graph.node.get`            | Retrieve a graph node by externalId.                                                                                                                      |
| `graph.node.delete`         | Delete a graph node and its relationships.                                                                                                                |
| `graph.node.search`         | Vector + full-text search over graph nodes.                                                                                                               |
| `graph.search`              | Unified natural-language semantic (vector) search across the entire knowledge graph by embedding similarity.                                               |
| `graph.relationship.upsert` | Create or update a directed typed relationship between two KnowledgeNodes (open-vocabulary type, replaces graph.edge.upsert).                             |
| `graph.edge.upsert`         | **Deprecated** — one-release alias for `graph.relationship.upsert`; removed in v2.                                                                        |
| `graph.edge.delete`         | Delete a directed relationship between two nodes.                                                                                                         |
| `graph.cypher`              | Execute a read-only Cypher query against the tenant graph.                                                                                                |
| `graph.ingest`              | Extract entities + relationships from text and commit them to the graph with confidence.                                                                  |
| `graph.stats`               | Workspace graph statistics: node/edge counts by type.                                                                                                     |
| `graph.export`              | Paginated, cursor-aware read of a workspace subgraph for local projection. Powers `oxagen graph pull`. See ADR-018.                                       |
| `graph.sync.push`           | Batch-upsert a content-addressed code or lineage subgraph (is_system=true). Idempotent — re-sending is a no-op. Powers `oxagen graph push`. See ADR-018. |
| `ontology.query`            | Typed multi-hop traversal from a start node over named relationship types.                                                    |
| `ontology.neighbors`        | One-hop neighborhood of a node, filtered by type and direction.                                                               |

## Image (4)

- [image.analyze](image.analyze.md) — Analyze an image by ID; returns description, tags, and analysis
- [image.create](image.create.md) — Generate an image from a prompt and persist it as a workspace asset
- [image.generate](image.generate.md) — Generate an image from a natural-language prompt via the Vercel AI Gateway
- [image.list](image.list.md) — List images in the workspace

## Integration (7)

- [integration.configure](integration.configure.md) — Update plugin instance config, cadence, and inference settings
- [integration.delete](integration.delete.md) — Remove a plugin instance and optionally purge graph data (async)
- [integration.get](integration.get.md) — Get full details of a single plugin instance including schema
- [integration.install](integration.install.md) — Install a plugin instance from catalog or custom URL (async)
- [integration.list](integration.list.md) — Browse installed plugin instances with status and sync metrics
- [integration.metrics](integration.metrics.md) — Get sync statistics and metrics for a plugin instance
- [integration.sync](integration.sync.md) — Trigger synchronization of a plugin instance (async)

## Mermaid (1)

- [mermaid.generate](mermaid.generate.md) — Produce a Mermaid diagram rendered inline in chat as a client-side SVG artifact

## Notifications (2)

- [notifications.list](notifications.list.md) — List in-app notifications for the calling user with unread filtering and pagination
- [notifications.mark](notifications.mark.md) — Mark a notification as read and/or archived for the calling user

## Org (7)

- [org.member.add](org.member.add.md) — Invite a user to join the org by email; enforces seat limits
- [org.member.invite.accept](org.member.invite.accept.md) — Accept a pending org invitation; creates membership and provisions IAM
- [org.member.invite.decline](org.member.invite.decline.md) — Decline a pending org invitation; frees the reserved license seat
- [org.member.remove](org.member.remove.md) — Permanently remove a member from the org; irreversible action with last-owner block
- [org.member.role.change](org.member.role.change.md) — Change a member's org role; blocks last-owner demotion
- [org.settings.read](org.settings.read.md) — Read the org's profile settings: name, slug, avatar, website, industry, employee size, type
- [org.settings.write](org.settings.write.md) — Update the org's profile settings (partial) through the kernel with IAM, metering, and audit

## Organization (1)

- [organization.create](organization.create.md) — Create a new organization with a globally-unique slug

## Plugin (20)

- [plugin.catalog.browse](plugin.catalog.browse.md) — Search and filter the MCP server catalog by text, category, transport, and auth kind
- [plugin.catalog.get](plugin.catalog.get.md) — Get full detail for one catalog server entry including README, packages, and transport types
- [plugin.credential.reauth](plugin.credential.reauth.md) — Initiate or complete an OAuth re-authentication flow for an expired plugin token
- [plugin.credential.set_secret](plugin.credential.set_secret.md) — Store or update an encrypted credential (API key or bearer token) for a plugin server
- [plugin.denylist.add](plugin.denylist.add.md) — Add a plugin server to the org denylist; immediately disables matching installs
- [plugin.denylist.remove](plugin.denylist.remove.md) — Remove a plugin server from the org denylist, making it installable again
- [plugin.org.install](plugin.org.install.md) — Install a catalog or custom server to the org allow-list; disabled by default
- [plugin.org.install_bulk](plugin.org.install_bulk.md) — Install multiple catalog or custom plugin servers to the org allow-list in one request
- [plugin.org.list](plugin.org.list.md) — List installed plugins and denylisted server names for the org with enabled/disabled status
- [plugin.org.set_enabled](plugin.org.set_enabled.md) — Toggle the enabled flag on an org-level plugin listing
- [plugin.org.uninstall](plugin.org.uninstall.md) — Soft-delete a plugin listing from the org allow-list and remove dependent workspace installs
- [plugin.registry.add](plugin.registry.add.md) — Add a custom MCP registry source for the org; triggers automatic catalog sync
- [plugin.registry.list](plugin.registry.list.md) — List MCP registries available to the org including the default seed registry
- [plugin.registry.remove](plugin.registry.remove.md) — Remove an org-added MCP registry source; the default registry cannot be removed
- [plugin.registry.sync](plugin.registry.sync.md) — Trigger an on-demand catalog sync for a registry (async)
- [plugin.schema.get](plugin.schema.get.md) — Fetch typed config schema for a connector plugin
- [plugin.schema.validate](plugin.schema.validate.md) — Validate a config object against a plugin schema
- [plugin.settings.set_auth_alerts](plugin.settings.set_auth_alerts.md) — Configure re-authentication alert preferences for the org
- [plugin.version.list](plugin.version.list.md) — List version history with changelog and breaking-change flags
- [plugin.workspace.set_enabled](plugin.workspace.set_enabled.md) — Enable/disable a plugin server for this workspace

## Privacy (2)

- [privacy.data.erase](privacy.data.erase.md) — Request erasure of personal or organizational data under GDPR Article 17
- [privacy.data.export](privacy.data.export.md) — Request a machine-readable ZIP archive of data under GDPR Article 20

## Prompt (2)

- [prompt.settings.read](prompt.settings.read.md) — Read the workspace prompt configuration including appended instructions and auto-improve toggle
- [prompt.settings.write](prompt.settings.write.md) — Update the workspace prompt configuration (partial update)

## Repo (10)

- [repo.branch.create](repo.branch.create.md) — Create a new branch in a GitHub repository, optionally from another branch
- [repo.configure](repo.configure.md) — Set repo-specific config: filters, inference, cadence, field mappings
- [repo.create](repo.create.md) — Create a new GitHub repository in an organization the user owns
- [repo.file.put](repo.file.put.md) — Commit a file (create or update) to a GitHub repository
- [repo.fork](repo.fork.md) — Fork a GitHub repository into the authenticated user's account or a specified organization
- [repo.metrics](repo.metrics.md) — Get sync statistics and metrics for a repository connection
- [repo.pause](repo.pause.md) — Pause automatic syncing for a repository connection
- [repo.pr.open](repo.pr.open.md) — Open a pull request in a GitHub repository
- [repo.resume](repo.resume.md) — Resume automatic syncing for a paused repository connection
- [repo.sync](repo.sync.md) — Trigger incremental or full re-index of a repository connection (async)

## Research (2)

- [research.swarm.start](research.swarm.start.md) — Fan out parallel web searches for a topic with diverse query variations; returns a swarmId to poll
- [research.swarm.status](research.swarm.status.md) — Poll the status of a running research swarm; returns task progress and partial results

## Schema (22)

- [schema.registry.get](schema.registry.get.md) — Resolve the workspace registry: pinned version, enforcement mode, and the full label/relationship/property tree
- [schema.registry.config](schema.registry.config.md) — Set enforcement mode and conformance floor for the workspace schema registry
- [schema.list](schema.list.md) — List workspace schemas with per-schema enabled state (lightweight listing without full tree)
- [schema.toggle](schema.toggle.md) — Enable/disable a schema; activation auto-publishes the draft and pins the resulting version
- [schema.label.upsert](schema.label.upsert.md) — Create or update a node label on a schema within the current draft version
- [schema.label.delete](schema.label.delete.md) — Remove a node label and all its properties from the current draft
- [schema.relationship.upsert](schema.relationship.upsert.md) — Create or update a relationship type on a schema within the current draft version
- [schema.relationship.delete](schema.relationship.delete.md) — Remove a relationship type from the current draft
- [schema.property.upsert](schema.property.upsert.md) — Create or update a property on a node label or relationship type in the current draft
- [schema.property.delete](schema.property.delete.md) — Remove a property from the current draft
- [schema.version.create](schema.version.create.md) — Freeze the current draft into an immutable published version and open a fresh draft
- [schema.version.pin](schema.version.pin.md) — Pin the workspace to a specific published schema version
- [schema.version.list](schema.version.list.md) — List all schema versions with status, label, and change summary
- [schema.version.diff](schema.version.diff.md) — Structural diff of two schema versions: added/removed/changed schemas, labels, types, and properties
- [schema.export](schema.export.md) — Export a schema version as a downloadable ZIP grouped by schema
- [schema.recommend](schema.recommend.md) — AI-generated schema recommendation based on existing graph structure and observed labels
- [schema.setup](schema.setup.md) — Interactive LLM-assisted schema setup wizard: recommend → Q&A → apply → activate
- [schema.chat](schema.chat.md) — AI iterative builder turn: takes conversation and draft, returns assistant message and proposed mutations
- [schema.validate.node](schema.validate.node.md) — Validate a node's properties against the workspace schema; returns conformance score and field errors
- [schema.validate.relationship](schema.validate.relationship.md) — Validate a relationship's type and properties against the workspace schema
- [schema.reconcile.dispatch](schema.reconcile.dispatch.md) — Dispatch an async job to re-label existing graph nodes and relationships against the pinned schema version
- [schema.reconcile.status](schema.reconcile.status.md) — Poll the progress and outcome of a schema reconciliation job

## Secret (8)

- [secret.key.upsert](secret.key.upsert.md) — Create or update a vault secret key at the workspace root; sensitive keys are envelope-encrypted, with an optional default value
- [secret.key.list](secret.key.list.md) — List vault secret keys with masked metadata; never returns plaintext values
- [secret.key.delete](secret.key.delete.md) — Soft-delete a vault secret key and hard-remove all of its per-environment overrides
- [secret.value.set](secret.value.set.md) — Set a secret's value override for a specific environment, encrypted or plaintext per the key's sensitive flag
- [secret.value.unset](secret.value.unset.md) — Remove a secret's per-environment override so it falls back to the key's default value
- [secret.import_env](secret.import_env.md) — Parse pasted .env text and preview/commit key upserts + value sets for the defaults or a chosen environment
- [secret.reveal](secret.reveal.md) — Reveal a single secret's plaintext value for an environment; Owner/Admin only, every reveal is audited (api, mcp)
- [secret.export](secret.export.md) — Export an environment's resolved secret set as decrypted key/value pairs and .env text; Owner/Admin only, every export is audited (api, mcp)

## Semantic (8)

- [semantic.relationship.approve](semantic.relationship.approve.md) — Approve or reject an inferred semantic relationship candidate; approved relationships become permanent Neo4j relationships
- [semantic.relationship.infer](semantic.relationship.infer.md) — Run LLM inference to discover cross-source relationships (async)
- [semantic.relationship.list](semantic.relationship.list.md) — Paginated browse of inferred semantic relationships with filtering
- [semantic.relationship.suggest](semantic.relationship.suggest.md) — Return unapproved relationship candidates for human review
- [semantic.edge.approve](semantic.edge.approve.md) — **Deprecated alias** for `semantic.relationship.approve`; removed in v2
- [semantic.edge.infer](semantic.edge.infer.md) — **Deprecated alias** for `semantic.relationship.infer`; removed in v2
- [semantic.edge.list](semantic.edge.list.md) — **Deprecated alias** for `semantic.relationship.list`; removed in v2
- [semantic.edge.suggest](semantic.edge.suggest.md) — **Deprecated alias** for `semantic.relationship.suggest`; removed in v2

## Skill (9)

- [skill.workspace.list](skill.workspace.list.md) — List skills available in the workspace
- [skill.workspace.install](skill.workspace.install.md) — Install a skill into a workspace from a builtin template or custom upload, idempotent on slug
- [skill.version.list](skill.version.list.md) — List the time-ordered version history for a workspace skill
- [skill.version.get](skill.version.get.md) — Fetch a specific version of a workspace skill including body and parsed frontmatter
- [skill.version.upload](skill.version.upload.md) — Upload a new immutable skill version from raw .skill.md content
- [skill.version.activate](skill.version.activate.md) — Set a specific skill version as the workspace's active version
- [skill.edit](skill.edit.md) — Save an edited skill body as a new immutable version
- [skill.export](skill.export.md) — Export a skill version as a downloadable .skill.md string
- [skill.metrics.read](skill.metrics.read.md) — Read aggregated skill usage and cost metrics for the workspace

## Svg (1)

- [svg.generate](svg.generate.md) — Generate clean, sanitized, inline SVG markup from a natural-language prompt

## System (1)

- [system.install.instructions](system.install.instructions.md) — Return ordered, copy-ready MCP/CLI installation instructions per client

## User (2)

- [user.preferences.read](user.preferences.read.md) — Read the calling user's UI and model preferences
- [user.preferences.write](user.preferences.write.md) — Update the calling user's UI and model preferences (partial update)

## Video (1)

- [video.generate](video.generate.md) — Generate a short video from a natural-language prompt (async)

## Web (2)

- [web.fetch](web.fetch.md) — Fetch a URL and return its content as clean markdown text
- [web.search](web.search.md) — Search the web using the Tavily API and return ranked results

## Workflow (3)

- [workflow.cancel](workflow.cancel.md) — Cancel a running or planning workflow run; transitions to cancelled status
- [workflow.run](workflow.run.md) — Decompose a goal into N sub-tasks and dispatch them concurrently via Inngest
- [workflow.status](workflow.status.md) — Read the current status and task-level progress of a workflow run

## Workspace (7)

- [workspace.create](workspace.create.md) — Create a workspace inside the caller's active tenant
- [workspace.invite.send](workspace.invite.send.md) — Send a workspace invitation to an email address with 7-day expiry
- [workspace.member.list](workspace.member.list.md) — List members of a workspace
- [workspace.model.settings.read](workspace.model.settings.read.md) — Read the workspace-level model defaults
- [workspace.model.settings.write](workspace.model.settings.write.md) — Update the workspace-level model defaults (partial update)
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
