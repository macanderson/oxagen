# Capabilities

Reference for all declared capabilities across the Oxagen platform.
Each capability is implemented across API, MCP, and agent surfaces with
contract-first design, IAM enforcement, and instrumentation.

## Agent (18)

- [agent.approval.resolve](agent.approval.resolve.md) — Approve or deny a pending tool-call approval request; resolution ends the tool-call wait and streams the next step
- [agent.code.execute](agent.code.execute.md) — Execute a code snippet in an isolated sandbox and return the exit code, stdout, stderr, and execution time
- [agent.execution.record](agent.execution.record.md) — Persist a complete agent execution record including steps, tool calls, and result summary for observability and audit
- [agent.mcp.list](agent.mcp.list.md) — List registered external MCP servers in the active workspace with status, transport, auth kind, and tool inventory
- [agent.mcp.register](agent.mcp.register.md) — Register an external MCP server with the workspace; the runner runs a separate process and injects its tools into the agent
- [agent.memory.recall](agent.memory.recall.md) — Query Neo4j AgentMemory nodes by semantic similarity plus a weight-sorted rank
- [agent.memory.write](agent.memory.write.md) — Persist a weighted memory tied to a graph node per the schema.memory contract
- [agent.plan.approve](agent.plan.approve.md) — Approve, deny, or amend a previously-proposed plan; approval releases the agent stream to execute the plan's side-effectful steps
- [agent.plan.create](agent.plan.create.md) — Create a structured hierarchical execution plan with tasks, dependencies, and approval gates; approval via agent.plan.approve is required before execution
- [agent.skill.list](agent.skill.list.md) — List skills available in the active workspace including built-in filesystem and dynamic marketplace-installed skills
- [agent.skill.load](agent.skill.load.md) — Load and register a workspace skill at runtime, resolving the requested version and parsing its configuration
- [agent.subagent.aggregate](agent.subagent.aggregate.md) — Wait for all child runs in a subagent fanout to complete and return merged results, conflict list, and execution timeline
- [agent.subagent.dispatch](agent.subagent.dispatch.md) — Fan out a set of tasks to multiple subagents running in parallel; returns a dispatchId to poll via agent.subagent.aggregate
- [agent.task.background.cancel](agent.task.background.cancel.md) — Cancel a running background task; downstream Inngest steps stop on cancellation
- [agent.task.background.read](agent.task.background.read.md) — Read the current status, progress markers, and final result of a background task
- [agent.task.background.start](agent.task.background.start.md) — Dispatch a long-running task as a durable Inngest job; the chat stream polls for status
- [agent.tool.list](agent.tool.list.md) — List the capabilities surfaced as agent tools for the active workspace, filtered by role, entitlements, and denylist
- [agent.ui.render](agent.ui.render.md) — Render a structured UI component from an agent response; the client maps the component type to a React renderer

## Api (2)

- [api.key.create](api.key.create.md) — Create a new API key scoped to the requesting org; the raw key is shown once and never retrievable
- [api.key.revoke](api.key.revoke.md) — Revoke an API key by its public ID; the key is soft-deleted and immediately invalid for all subsequent requests

## Archive (1)

- [archive.create](archive.create.md) — Bundle one or more items into a ZIP archive and upload to storage; returns a file-attachment render directive

## Asset (1)

- [asset.upload](asset.upload.md) — Ingest a binary asset from a publicly reachable source URL into object storage

## Automation (5)

- [automation.create](automation.create.md) — Create a playbook and trigger for an automation with configurable trigger type (event, schedule, or manual)
- [automation.disable](automation.disable.md) — Disable an automation trigger so it stops firing; safe to call without approval
- [automation.enable](automation.enable.md) — Enable an automation trigger so it fires live; the only path from configured to live, gated by human approval
- [automation.list](automation.list.md) — List automation rules in the caller's active workspace, ordered by creation date descending
- [automation.trigger](automation.trigger.md) — Manually trigger an automation by ID with an optional payload; creates a run record

## Audit (1)

| Capability         | Notes                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| `audit.log.query`  | Query security + automation audit spines (org-scoped); admin-only, read-only. |

## Billing (3)

- [billing.credits.purchase](billing.credits.purchase.md) — Initiate a dynamic usage-credit purchase via Stripe Checkout with automatic volume discount
- [billing.subscription.read](billing.subscription.read.md) — Return the active subscription, plan slug, current period bounds, and available credits
- [billing.subscription.upgrade.start](billing.subscription.upgrade.start.md) — Begin a plan change via Stripe Checkout; returns a URL for the user to complete

## Brandkit (1)

- [brandkit.apply](brandkit.apply.md) — Apply a workspace brand kit (colours, fonts, logos) to an existing cloud file (stub)

## Chat (2)

- [chat.message.execution](chat.message.execution.md) — Record an agent execution that originated from a chat message; atomically links execution to message for observability
- [chat.message.send](chat.message.send.md) — Append a user message to a conversation and stream the assistant's response

## Connection (8)

- [connection.create](connection.create.md) — Create a new data source connection for a workspace; credentials are encrypted before storage
- [connection.delete](connection.delete.md) — Delete a data source connection with three modes: connection_only, data_only, or full deletion
- [connection.get](connection.get.md) — Get details of a single data source connection
- [connection.list](connection.list.md) — List all data source connections for a workspace
- [connection.mappings.get](connection.mappings.get.md) — Get the current entity type mappings for a data source connection
- [connection.mappings.set](connection.mappings.set.md) — Save entity type mappings for a data source connection; activates connection and starts ingestion
- [connection.mappings.suggest](connection.mappings.suggest.md) — Use an LLM to suggest entity type mappings based on previewed record types
- [connection.preview](connection.preview.md) — Preview sample records from a data source connection for the setup wizard

## Conversation (6)

- [conversation.archive](conversation.archive.md) — Archive or restore one or more conversations in a single set-based update
- [conversation.chat](conversation.chat.md) — Post a message to an existing conversation; appends to the conversation thread
- [conversation.delete](conversation.delete.md) — Permanently delete one or more conversations from the user's view via soft-delete
- [conversation.list](conversation.list.md) — List a user's conversations in a workspace, filtered by active or archived status
- [conversation.purge](conversation.purge.md) — Bulk soft-delete every archived conversation the caller owns in the active workspace
- [conversation.rename](conversation.rename.md) — Set a conversation's title; low-risk metadata edit exposed via long-press or double-click

## Document (3)

- [document.create](document.create.md) — Create a new document in the workspace
- [document.list](document.list.md) — List documents in the workspace
- [document.read](document.read.md) — Read a document by ID; returns title, content, and metadata

## Documents (2)

- [documents.generate](documents.generate.md) — Generate a new document, spreadsheet, or presentation in a cloud provider (stub)
- [documents.pdf.create](documents.pdf.create.md) — Render a PDF from either raw HTML or an existing cloud file (stub)

## Form (3)

- [form.create](form.create.md) — Create a new form with optional field definitions
- [form.fill](form.fill.md) — Generatively fill or suggest values for page-level form fields based on context
- [form.submit](form.submit.md) — Submit a response to a form

## Graph (9)

| Capability          | Notes                                                       |
| ------------------- | ----------------------------------------------------------- |
| `graph.node.list`   | Paginated browse of all nodes in the workspace graph.       |
| `graph.node.upsert` | Create or update a graph node by externalId.                |
| `graph.node.get`    | Retrieve a graph node by externalId.                        |
| `graph.node.delete` | Delete a graph node and its relationships.                  |
| `graph.node.search` | Vector + full-text search over graph nodes.                 |
| `graph.edge.upsert` | Create or update a directed relationship between two nodes. |
| `graph.edge.delete` | Delete a directed relationship between two nodes.           |
| `graph.cypher`      | Execute a read-only Cypher query against the tenant graph.  |
| `graph.stats`       | Workspace graph statistics: node/edge counts by type.       |
| `ontology.query`     | Typed multi-hop traversal from a start node over named relationship types. |
| `ontology.neighbors` | One-hop neighborhood of a node, filtered by type and direction.            |

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

## Notifications (2)

- [notifications.list](notifications.list.md) — List in-app notifications for the calling user with unread filtering and pagination
- [notifications.mark](notifications.mark.md) — Mark a notification as read and/or archived for the calling user

## Org (5)

- [org.member.add](org.member.add.md) — Invite a user to join the org by email; enforces seat limits
- [org.member.invite.accept](org.member.invite.accept.md) — Accept a pending org invitation; creates membership and provisions IAM
- [org.member.invite.decline](org.member.invite.decline.md) — Decline a pending org invitation; frees the reserved license seat
- [org.member.remove](org.member.remove.md) — Permanently remove a member from the org; irreversible action with last-owner block
- [org.member.role.change](org.member.role.change.md) — Change a member's org role; blocks last-owner demotion

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

## Repo (5)

- [repo.configure](repo.configure.md) — Set repo-specific config: filters, inference, cadence, field mappings
- [repo.metrics](repo.metrics.md) — Get sync statistics and metrics for a repository connection
- [repo.pause](repo.pause.md) — Pause automatic syncing for a repository connection
- [repo.resume](repo.resume.md) — Resume automatic syncing for a paused repository connection
- [repo.sync](repo.sync.md) — Trigger incremental or full re-index of a repository connection (async)

## Research (2)

- [research.swarm.start](research.swarm.start.md) — Fan out parallel web searches for a topic with diverse query variations; returns a swarmId to poll
- [research.swarm.status](research.swarm.status.md) — Poll the status of a running research swarm; returns task progress and partial results

## Semantic (4)

- [semantic.edge.approve](semantic.edge.approve.md) — Approve or reject an inferred semantic edge candidate; approved edges become permanent Neo4j relationships
- [semantic.edge.infer](semantic.edge.infer.md) — Run LLM inference to discover cross-source relationships (async)
- [semantic.edge.list](semantic.edge.list.md) — Paginated browse of inferred semantic edges with filtering
- [semantic.edge.suggest](semantic.edge.suggest.md) — Return unapproved edge candidates for human review

## Skill (1)

- [skill.workspace.list](skill.workspace.list.md) — List skills available in the workspace

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

## Workspace (5)

- [workspace.create](workspace.create.md) — Create a workspace inside the caller's active tenant
- [workspace.invite.send](workspace.invite.send.md) — Send a workspace invitation to an email address with 7-day expiry
- [workspace.member.list](workspace.member.list.md) — List members of a workspace
- [workspace.model.settings.read](workspace.model.settings.read.md) — Read the workspace-level model defaults
- [workspace.model.settings.write](workspace.model.settings.write.md) — Update the workspace-level model defaults (partial update)

## Partner connectors

Oxagen supports both built-in connectors (GitHub, Google Drive, Slack, Linear)
and partner-authored connectors loaded from a hosted `schema.yaml` URL.

Partner schemas follow the same `ConnectorPlugin` format as built-in schemas.
The platform fetches, validates, and caches partner schemas transparently —
the `plugin.schema.get` and `integration.install` capabilities handle both
paths without separate APIs.

| Resource | Description |
| -------- | ----------- |
| [Connector Authoring Guide](../guides/connector-authoring.md) | How to author a `schema.yaml` for a partner connector — schema sections, field widgets, validation patterns, AI prompt best practices, and testing. |
| [Partner Registration](../guides/partner-registration.md) | Registration workflow, marketplace listing requirements, security checklist, and support SLA. |
| `packages/ingestion/src/connectors/example-saas/schema.yaml` | Fully annotated reference schema demonstrating every section and field type. |

To install a partner connector by schema URL:
```bash
oxagen integrations install \
  --plugin-id my-platform \
  --schema-url https://cdn.mycompany.com/oxagen/schema.yaml \
  --display-name "My Platform" \
  --config '{"accountId":"acme"}'
```
