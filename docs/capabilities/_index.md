# Linear backlog — capabilities

All declared capabilities are filed in `oxagen-v2` (team OXA,
project ID `31ab7de2-021f-486d-9f6f-718a7976c027`).

## Foundations (4)

| Capability                  | Linear   |
| --------------------------- | -------- |
| `organization.create`       | OXA-1326 |
| `workspace.create`          | OXA-1327 |
| `billing.subscription.read` | OXA-1328 |
| `chat.message.send`         | OXA-1329 |

## Agent runtime (16)

| Capability                       | Linear   |
| -------------------------------- | -------- |
| `agent.tool.list`                | OXA-1330 |
| `agent.subagent.dispatch`        | OXA-1331 |
| `agent.subagent.aggregate`       | OXA-1324 |
| `agent.code.execute`             | OXA-1325 |
| `agent.mcp.register`             | OXA-1332 |
| `agent.mcp.list`                 | OXA-1333 |
| `agent.skill.list`               | OXA-1334 |
| `agent.skill.load`               | OXA-1335 |
| `agent.plan.create`              | OXA-1336 |
| `agent.plan.approve`             | OXA-1337 |
| `agent.task.background.start`    | OXA-1338 |
| `agent.task.background.read`     | OXA-1339 |
| `agent.task.background.cancel`   | OXA-1340 |
| `agent.memory.recall`            | OXA-1341 |
| `agent.memory.write`             | OXA-1342 |
| `agent.approval.resolve`         | OXA-1343 |

## API keys (2)

| Capability        | Notes                                      |
| ----------------- | ------------------------------------------ |
| `api.key.create`  | Create org API key; raw key shown once.    |
| `api.key.revoke`  | Soft-delete API key; immediately invalid.  |

## Assets & archives (2)

| Capability       | Notes                                              |
| ---------------- | -------------------------------------------------- |
| `archive.create` | Bundle assets/blobs into a ZIP in Vercel Blob.     |
| `asset.upload`   | Ingest binary from URL into object storage.        |

## Billing (3)

| Capability                           | Notes                                             |
| ------------------------------------ | ------------------------------------------------- |
| `billing.credits.purchase`           | Start Stripe Checkout for credit purchase.        |
| `billing.subscription.upgrade.start` | Start Stripe Checkout for plan upgrade.           |
| `billing.subscription.read`          | Read current subscription and credit balance.     |

## Brand kit (1)

| Capability      | Notes                              |
| --------------- | ---------------------------------- |
| `brandkit.apply` | Apply brand kit to cloud file (stub). |

## Conversations (5)

| Capability             | Notes                                                  |
| ---------------------- | ------------------------------------------------------ |
| `conversation.archive` | Archive or restore conversations (reversible).         |
| `conversation.delete`  | Soft-delete specific conversations (irreversible).     |
| `conversation.list`    | List active or archived conversations, paginated.      |
| `conversation.purge`   | Soft-delete ALL archived conversations (irreversible). |
| `conversation.rename`  | Set a conversation's title.                            |

## Documents (3)

| Capability             | Notes                                               |
| ---------------------- | --------------------------------------------------- |
| `documents.generate`   | Generate DOCX/XLSX/PPTX via cloud provider (stub).  |
| `documents.pdf.create` | Generate PDF from HTML or cloud file (stub).        |
| `form.fill`            | Generatively fill page form fields.                 |

## Image / video / SVG generation (3)

| Capability      | Notes                                          |
| --------------- | ---------------------------------------------- |
| `image.generate` | Generate image via AI Gateway (gpt-image-1).  |
| `svg.generate`  | Generate sanitized SVG from prompt.            |
| `video.generate` | Generate video from prompt (stub).            |

## Notifications (2)

| Capability           | Notes                               |
| -------------------- | ----------------------------------- |
| `notifications.list` | List in-app notifications for user. |
| `notifications.mark` | Mark notification read/archived.    |

## Organization (1)

| Capability            | Notes                                        |
| --------------------- | -------------------------------------------- |
| `organization.create` | Create a new org with globally-unique slug.  |

## Org members (5)

| Capability                    | Notes                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `org.member.add`              | Invite user to org by email; enforces seat limits.           |
| `org.member.invite.accept`    | Accept a pending invitation; creates membership + IAM.       |
| `org.member.invite.decline`   | Decline a pending invitation; frees reserved seat.           |
| `org.member.remove`           | Remove member; revokes IAM. Blocks last-owner removal.       |
| `org.member.role.change`      | Change member's org role; blocks last-owner demotion.        |

## Integrations (7)

| Capability               | Notes                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| `integration.install`    | Install a plugin instance from catalog or custom URL (async).      |
| `integration.configure`  | Update plugin instance config, cadence, and inference settings.    |
| `integration.list`       | Browse installed plugin instances with status and sync metrics.     |
| `integration.get`        | Get full details of a single plugin instance including schema.      |
| `integration.sync`       | Trigger synchronization of a plugin instance (async).              |
| `integration.metrics`    | Get sync statistics and metrics for a plugin instance.             |
| `integration.delete`     | Remove a plugin instance and optionally purge graph data (async).  |

## Plugins (20)

| Capability                       | Notes                                                          |
| -------------------------------- | -------------------------------------------------------------- |
| `plugin.catalog.browse`          | Search the MCP server catalog.                                 |
| `plugin.catalog.get`             | Get full detail for one catalog entry.                         |
| `plugin.credential.reauth`       | Initiate OAuth re-auth for expired plugin credential.          |
| `plugin.credential.set_secret`   | Store encrypted credential (API key / OAuth token).            |
| `plugin.denylist.add`            | Add server to org denylist; immediately disables installs.     |
| `plugin.denylist.remove`         | Remove server from org denylist.                               |
| `plugin.org.install`             | Install catalog or custom server to org allow-list.            |
| `plugin.org.install_bulk`        | Bulk install multiple servers to org allow-list.               |
| `plugin.org.list`                | List org plugin listings and denylisted servers.               |
| `plugin.org.set_enabled`         | Toggle enabled flag on org plugin listing.                     |
| `plugin.org.uninstall`           | Soft-delete org listing and remove workspace installs.         |
| `plugin.registry.add`            | Add custom MCP registry for the org.                           |
| `plugin.registry.list`           | List MCP registries (global seed + org-added).                 |
| `plugin.registry.remove`         | Remove org-added MCP registry.                                 |
| `plugin.registry.sync`           | Trigger on-demand catalog sync (async).                        |
| `plugin.settings.set_auth_alerts` | Configure OAuth re-auth alert preferences.                    |
| `plugin.workspace.set_enabled`   | Enable/disable plugin server for this workspace.               |
| `plugin.schema.get`              | Fetch typed config schema for a connector plugin.              |
| `plugin.schema.validate`         | Validate a config object against a plugin schema.              |
| `plugin.version.list`            | List version history with changelog and breaking-change flags.  |

## System (1)

| Capability                    | Notes                                            |
| ----------------------------- | ------------------------------------------------ |
| `system.install.instructions` | Return MCP/CLI install instructions per client.  |

## User preferences (2)

| Capability               | Notes                                                   |
| ------------------------ | ------------------------------------------------------- |
| `user.preferences.read`  | Read calling user's UI and model preferences.           |
| `user.preferences.write` | Update calling user's UI and model preferences (PATCH). |

## Workspace (3)

| Capability                          | Notes                                              |
| ----------------------------------- | -------------------------------------------------- |
| `workspace.create`                  | Create workspace inside the caller's tenant.       |
| `workspace.model.settings.read`     | Read workspace-level model defaults.               |
| `workspace.model.settings.write`    | Update workspace-level model defaults (PATCH).     |

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

## Web (2)

| Capability   | Notes                                                |
| ------------ | ---------------------------------------------------- |
| `web.search` | Search the web via Tavily and return ranked results. |
| `web.fetch`  | Fetch and extract clean text from a URL.             |

## Repo (5)

| Capability        | Notes                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| `repo.configure`  | Set repo-specific config: filters, inference, cadence, field mappings.       |
| `repo.sync`       | Trigger incremental or full re-index of a repository connection (async).     |
| `repo.pause`      | Pause automatic syncing for a repository connection.                         |
| `repo.resume`     | Resume automatic syncing for a paused repository connection.                 |
| `repo.metrics`    | Get sync statistics and metrics for a repository connection.                 |

## Semantic edges (3)

| Capability                | Notes                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| `semantic.edge.infer`     | Run LLM inference to discover cross-source relationships (async).    |
| `semantic.edge.list`      | Paginated browse of inferred semantic edges with filtering.          |
| `semantic.edge.suggest`   | Return unapproved edge candidates for human review.                  |

## Research (2)

| Capability              | Notes                                                   |
| ----------------------- | ------------------------------------------------------- |
| `research.swarm.start`  | Start a multi-agent research swarm for a given topic.   |
| `research.swarm.status` | Poll the status and results of a running research swarm.|

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
