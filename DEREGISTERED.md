# De-registered features

The register of every feature Oxagen has taken off its surfaces without taking
out of the tree. A de-registered feature is **not** a deleted feature. Its
contract, handler, route, tool, page, component and package stay exactly where
they are, keep compiling, and keep their tests. What it loses is reach: it is no
longer offered to a user, an agent or an API caller.

This file is the reference for that distinction. `docs/specs/mission-control/spec.md`
Appendix E decides *which* features come off the surfaces for rev1; this file
records *what that means for the code* and where the code is, so a later session
reshaping the product can find a capability it needs rather than rebuild one that
already exists.

**Status:** opened 2026-09-16, ahead of the rev1 app cutover
(`docs/specs/mission-control/plan.md`, integration branch `app-rebuild`). Every
path below exists on `main` today.

---

## 1. The rule

> **De-registered means unregistered, not deleted. Nothing in this file is
> removed from the tree without an ADR that says so by name.**

Three levers, applied independently:

| Lever | What it does | What it does not do |
|---|---|---|
| Drop `app` from a contract's `layers[]` | Removes the promise that a human can operate it in `apps/app`. `pnpm check:ui-parity` stops requiring a bound, proven page. | Delete the page |
| Drop `api` / `mcp` / `cli` from `surfaces[]` | Stops the capability being served on that surface. | Delete the route, the tool or the command |
| Remove the registration from `packages/handlers/src/register.ts` | Takes the capability out of `invoke()` dispatch entirely. | Delete the handler |

A de-registered feature reached through any of these keeps every file. The
registration is one line; the capability behind it is thousands.

**Why.** Oxagen is pre-customer and still finding its shape. A scope decision
made for one release is a statement about what we sell this quarter, not a
judgement that the code was wrong. Deleting on a scope decision converts a
reversible call into an irreversible one and charges a rebuild for the reversal.
Keeping the code costs a compile, a test run and this file.

**The one thing that is not free.** Dead code that nobody can reach still has to
typecheck, still shows up in review, and still has to survive a dependency bump.
That is the rent. It is paid deliberately, per feature, and the table below is
the invoice. When the rent stops being worth paying for a row, the answer is an
ADR that deletes it, not a quiet prune.

---

## 2. How to read the tables

Every capability in this repo follows one naming convention, so one stem locates
all four of its artifacts:

| Artifact | Path |
|---|---|
| Contract | `packages/oxagen/src/contracts/<stem>.ts` |
| Handler | `packages/handlers/src/<stem>.ts` |
| API route | `apps/api/src/routes/v1/<stem>.ts` |
| MCP tool | `apps/mcp/src/tools/<stem>.ts` |

The **Parity** column says which of those four exist today: `C` contract,
`H` handler, `A` per-file API route, `M` MCP tool. A missing `A` usually means
the capability dispatches from a combined route file (`connection.ts`, `repo.ts`,
`plugin-schema.ts`), which `tools/scripts/check_manifest.mjs` content-scans — see
CLAUDE.md, "check:manifest combined route files". A missing `H` means the handler
is registered from somewhere other than a file of that name.

Note the stem is the *file* name, which is often still the pre-ADR-025 dotted
form (`plugin.org.install.ts`), while the **registered name** is verb-first snake
case (`install_plugin`). Both are given.

---

## 3. Marketplace and installable plugins

**De-registered by:** spec Appendix E, "no marketplace in v1; sources and tool
servers replace it". Out of scope per spec §2.2.
**Replaced on the surface by:** `add_source` / `update_source` / `remove_source` /
`list_sources` (spec Appendix E, "Ontology and knowledge"), which absorb
`install_plugin`, `uninstall_plugin` and `list_plugins` for the ingestion case,
and `register_tool_server` for the tool-server case.
**Not replaced at all:** the catalog itself — browsing, registries, versions,
bulk install, plugin-declared schemas, entitlement toggles. Those have no v1
equivalent. That is the reason this section is the longest one in the file.

| Registered name | Stem | Parity | What it does |
|---|---|---|---|
| `browse_plugin_catalog` | `plugin.catalog.browse` | CHAM | Search and page the plugin catalog |
| `get_catalog_plugin` | `plugin.catalog.get` | CHAM | One catalog entry with its versions |
| `sync_plugin_catalog` | `plugin.catalog.sync` | C_AM | Re-sync the catalog from its registries (worker: `packages/inngest-functions/src/functions/plugin.catalog-sync.ts`) |
| `install_plugin` | `plugin.org.install` | CHAM | Install one plugin into an org or workspace |
| `install_plugins_bulk` | `plugin.org.install_bulk` | CHAM | Install many in one call |
| `uninstall_plugin` | `plugin.org.uninstall` | CHAM | Remove an installation |
| `list_plugins` | `plugin.org.list` | CHAM | The org's installed plugins |
| `set_plugin_enabled` | `plugin.set_enabled` | CHAM | Enable or disable an installation |
| `add_plugin_registry` | `plugin.registry.add` | CHAM | Add a plugin registry source |
| `remove_plugin_registry` | `plugin.registry.remove` | CHAM | Remove one |
| `list_plugin_registries` | `plugin.registry.list` | CHAM | The org's registries |
| `list_plugin_versions` | `plugin.version.list` | CH_M | Versions of one plugin |
| `get_plugin_schema` | `plugin.schema.get` | CH_M | A plugin's declared connector schema |
| `validate_plugin_schema` | `plugin.schema.validate` | CH_M | Validate a schema against the connector spec |
| `set_plugin_secret` | `plugin.credential.set_secret` | CHAM | Write credential material for an installation |
| `revoke_plugin_credential` | `plugin.credential.revoke` | CHAM | Revoke it |
| `reauth_plugin_credential` | `plugin.credential.reauth` | CHAM | Re-run the OAuth dance |
| `get_auth_alerts` | `plugin.settings.get_auth_alerts` | CHAM | Expiring-credential alert settings |
| `set_auth_alerts` | `plugin.settings.set_auth_alerts` | CHAM | Write them |

Three of the credential rows (`set_plugin_secret`, `revoke_plugin_credential`,
`reauth_plugin_credential`) are absorbed rather than dropped: Appendix E folds
them into `set_connection` and `delete_connection`. They are listed here because
the *plugin-shaped* entry points come off the surfaces even though the behaviour
survives under the connection vocabulary.

### Supporting code, kept whole

| Path | What it is |
|---|---|
| `packages/plugins/src/registry/` | Plugin manifest registry, catalog resolution, version selection |
| `packages/plugins/src/entitlements/` | The capability entitlement gate and `bootstrapEntitlementRuntime()` |
| `packages/plugins/src/oauth/` | Provider detection, state store, preregistered clients |
| `packages/plugins/src/credentials/` | Workspace credential management and KMS |
| `packages/plugins/src/vault/` | Secret storage for installations |
| `packages/oxagen/src/plugins/` | Plugin manifest registry and the built-in plugin catalogs in the kernel |
| `packages/inngest-functions/src/functions/plugin.catalog-sync.ts` | The durable catalog sync job |
| `packages/database/src/schema/plugin.ts` | The Postgres tables installations and registries live in |

The entitlement gate is load-bearing beyond the marketplace: `setCapabilityEntitlementGate()`
fires in the `invoke()` pipeline for any plugin-claimed contract. De-registering
the marketplace does not de-register the gate.

### UI, kept whole

| Path | Route |
|---|---|
| `apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/marketplace/` | `/{org}/{ws}/marketplace` |
| `.../marketplace/agent-tools/` | `/{org}/{ws}/marketplace/agent-tools` |
| `.../marketplace/integrations/` | `/{org}/{ws}/marketplace/integrations` |
| `.../marketplace/integrations/[connectorId]/` | one connector's setup flow |

Appendix F folds all four routes into the **Tools** page. The plan's `proxy.ts`
redirect map sends `/{org}/{ws}/marketplace` to `/{org}/{ws}/tools`. The pages
themselves stay on disk, unrouted, until an ADR says otherwise.

---

## 4. Connectors beyond the three

**De-registered by:** spec §2.2 ("Connectors beyond the three named") and the v2
contract, which closes the connector id to an enum:
`packages/oxagen/src/contracts/v2/add-source.ts:119` and `:146` are
`z.enum(["github", "linear", "postgres"])`.

This is the sharpest case in the file, because nothing here is dropped from a
registry — the connectors stay registered in
`packages/ingestion/src/connectors/index.ts` and resolve fine through
`getConnector()`. They are simply unnameable through `add_source`. Reopening them
is one enum.

| Connector | Path | v1 |
|---|---|---|
| GitHub | `packages/ingestion/src/connectors/github/` | **kept** |
| Linear | `packages/ingestion/src/connectors/linear/` | **kept** |
| Custom SQL (the Postgres source) | `packages/ingestion/src/connectors/custom-sql/` | **kept** as `postgres` |
| Google Drive | `packages/ingestion/src/connectors/google/drive.ts` | de-registered |
| Google Calendar | `packages/ingestion/src/connectors/google/calendar.ts` | de-registered |
| Google Gmail | `packages/ingestion/src/connectors/google/gmail.ts` | de-registered |
| Google Meet | `packages/ingestion/src/connectors/google/meet.ts` | de-registered |
| Google Tasks | `packages/ingestion/src/connectors/google/tasks.ts` | de-registered |
| Google Contacts | `packages/ingestion/src/connectors/google/contacts.ts` | de-registered |
| Google BigQuery | `packages/ingestion/src/connectors/google/bigquery.ts` | de-registered |
| Zoom | `packages/ingestion/src/connectors/zoom/` | de-registered |
| Slack | `packages/ingestion/src/connectors/slack/` | de-registered |
| Salesforce | `packages/ingestion/src/connectors/salesforce/` | de-registered |
| Microsoft 365 | `packages/ingestion/src/connectors/microsoft/` | de-registered |
| Stripe (a customer's own account as entities) | `packages/ingestion/src/connectors/stripe/` | de-registered |
| Zendesk | `packages/ingestion/src/connectors/zendesk/` | de-registered |
| Custom webhook | `packages/ingestion/src/connectors/custom-webhook/` | de-registered |

Fourteen de-registered, three kept, of seventeen implemented.
`packages/ingestion/src/connectors/example-saas/` ships a `schema.yaml` for the
plugin-schema docs and has no implementation; it is not counted.

**The pipeline itself is not de-registered.** `packages/ingestion/src/pipeline.ts`,
the dedup and entity-resolution code, the embedding path and the Neo4j upsert are
the backbone of the v1 Ontology page (spec §11.2). Nothing in `packages/ingestion`
comes off the surfaces except the fourteen connector ids above.

---

## 5. Environments

**De-registered by:** spec Appendix E, "`environment.*` and
`bind/unbind_agent_environment` (no runtime)". ADR-043 excised the runtime from
this repo; environments configured a runtime Oxagen no longer operates.
**Replaced by:** nothing. Stella owns execution environments now.

| Registered name | Stem | Parity |
|---|---|---|
| `create_environment` | `environment.create` | CHAM |
| `update_environment` | `environment.update` | CHAM |
| `delete_environment` | `environment.delete` | CHAM |
| `get_environment` | `environment.get` | CHAM |
| `list_environments` | `environment.list` | CHAM |
| `set_default_environment` | `environment.set_default` | CHAM |
| `bind_agent_environment` | `agent.environment.bind` | CHAM |
| `unbind_agent_environment` | `agent.environment.unbind` | CHAM |
| `list_agent_environments` | `agent.environment.list` | CHAM |

Supporting code kept: `packages/plugins/src/environments/`,
`packages/database/src/schema/environments.ts`, and the UI at
`apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/workbench/environments/` (Appendix F
folds the route into **Agents**).

---

## 6. Prompt settings

**De-registered by:** spec Appendix E, "steering replaces prompt settings".
**Replaced by:** the steering record model (spec §9, §10) — published directive
and knowledge records delivered through Context PRs.

| Registered name | Stem | Parity |
|---|---|---|
| `get_prompt_settings` | `prompt.settings.read` | CHAM |
| `update_prompt_settings` | `prompt.settings.write` | CHAM |

CLAUDE.md still carries a gotcha telling agents to reach for these contracts for
system-prompt customization. That stays true until steering ships; when it does,
the gotcha is rewritten to point at steering, and these two rows stay here.

---

## 7. Secrets read and bulk paths

**De-registered by:** spec Appendix E, "secrets are connections and are never
revealed".
**Replaced by:** `set_connection` and `delete_connection`, plus the credential
broker (spec §6.8) as the only path to secret material.

| Registered name | Stem | Parity |
|---|---|---|
| `import_env_secrets` | `secret.import_env` | CHAM |
| `export_secrets` | `secret.export` | CHAM |
| `reveal_secret` | `secret.reveal` | CHAM |

`reveal_secret` is the one row in this file with a standing argument for deletion
rather than preservation: a capability that returns plaintext secret material is
a liability whether or not it is registered. It is kept for now because it is
still reachable on `main` and removing it is a security change that deserves its
own PR and its own ADR, not a line in a scope document. Treat it as the first
candidate when this file is next pruned.

---

## 8. Memory import

**De-registered by:** spec Appendix E, "records are appended, not imported".
**Replaced by:** `append_record` / `propose_record` (`packages/oxagen/src/contracts/v2/`).

| Registered name | Stem | Parity |
|---|---|---|
| `parse_memory_import` | `agent.memory_import.parse` | C_AM |
| `commit_memory_import` | `agent.memory_import.commit` | C_AM |

---

## 9. Repository reads

**De-registered by:** spec Appendix E, "the graph and the GitHub events hold
these; agents read code through their own harness".
**Replaced by:** the code graph built by `link_repository` and `sync_repository`
(spec §11.4), queried through `search_graph` / `expand_graph` / `query_graph`.

| Registered name | Stem | Parity |
|---|---|---|
| `get_pr` | `repo.pr.get` | CH_M |
| `get_pr_diff` | `repo.pr.diff` | CH_M |
| `list_branches` | `repo.branch.list` | CH_M |
| `get_ci_status` | `repo.ci.status` | CH_M |

Appendix E also names `read_file` in this family. There is no registered
`read_file` contract on `main` — the only match is a test fixture in
`packages/oxagen/src/contracts/tool.declaration.publish.test.ts`. Nothing to
preserve; the Appendix E mention is a spec defect, recorded here rather than
filed, because it costs nothing and changes nothing.

---

## 10. Assets

**De-registered by:** spec Appendix E, "no content". ADR-043 removed content
generation from this repo.

| Registered name | Stem | Parity |
|---|---|---|
| `upload_asset` | `asset.upload` | CHAM |

`packages/storage` (the Vercel Blob and filesystem drivers) is **not**
de-registered — avatars and workspace file uploads still use it.

---

## 11. Reads folded into their objects

**De-registered by:** spec Appendix E, "reads folded into the objects above".
Each of these returned a slice that a surviving tool now returns whole, so the
narrow read is redundant rather than wrong.

| Registered name | Stem | Parity | Folded into |
|---|---|---|---|
| `get_org_settings` | `org.settings.read` | CHAM | `update_org` / `get_data_plane` |
| `get_workspace_settings` | `workspace.settings.read` | CHAM | `update_workspace` |
| `get_connection` | `connection.get` | CH_M | `list_sources` (detail mode) |
| `get_connection_mappings` | `connection.mappings.get` | CH_M | `list_sources` (detail mode) |
| `get_memory_policy` | `agent.memory_policy.read` | CHAM | `update_workspace` |
| `get_routing_policy` | `router.policy.get` | CHAM | `update_workspace` |
| `get_environment` | `environment.get` | CHAM | §5 above |
| `get_prompt_settings` | `prompt.settings.read` | CHAM | §6 above |

---

## 12. Procedure

**To de-register a feature.** In one PR: drop the layer or surface from the
contract (or the registration from `register.ts`), add the redirect if a route
goes away, add a row to the right section of this file with its stem, its parity
and what replaces it, and run `pnpm check:deregistered`. Do not delete files. If
the feature has no replacement, say so in the section header — a gap that nobody
wrote down is a gap that gets rediscovered as a bug.

**To re-register a feature.** Put the layer, surface or registration back, wire
the UI binding in `apps/app/capability-ui-map.json` if it claims `app`, prove the
page per the UI Capability Parity rule in CLAUDE.md, and delete its row from this
file. A row here is a claim that the feature is unreachable; leaving a stale row
is worse than having none.

**To actually delete a feature.** Write an ADR under `docs/adr/` naming the files
and saying why the rent stopped being worth paying. Land the deletion in a PR
that cites it. Move the row from its section to §13 with the ADR number. This is
the only path from this file to `git rm`.

---

## 13. Deleted, with an ADR

Nothing yet.

| Feature | ADR | Deleted in | Recoverable from |
|---|---|---|---|

---

## 14. Preserved paths

The guard `pnpm check:deregistered` (`tools/scripts/check-deregistered.mjs`)
asserts every path in the block below still exists. It fails when one is deleted
without an ADR — which is the whole point of this file. Keep the block in sync
when a row is added.

```preserved-paths
packages/oxagen/src/contracts/plugin.catalog.browse.ts
packages/oxagen/src/contracts/plugin.catalog.get.ts
packages/oxagen/src/contracts/plugin.catalog.sync.ts
packages/oxagen/src/contracts/plugin.org.install.ts
packages/oxagen/src/contracts/plugin.org.install_bulk.ts
packages/oxagen/src/contracts/plugin.org.uninstall.ts
packages/oxagen/src/contracts/plugin.org.list.ts
packages/oxagen/src/contracts/plugin.set_enabled.ts
packages/oxagen/src/contracts/plugin.registry.add.ts
packages/oxagen/src/contracts/plugin.registry.remove.ts
packages/oxagen/src/contracts/plugin.registry.list.ts
packages/oxagen/src/contracts/plugin.version.list.ts
packages/oxagen/src/contracts/plugin.schema.get.ts
packages/oxagen/src/contracts/plugin.schema.validate.ts
packages/oxagen/src/contracts/plugin.credential.set_secret.ts
packages/oxagen/src/contracts/plugin.credential.revoke.ts
packages/oxagen/src/contracts/plugin.credential.reauth.ts
packages/oxagen/src/contracts/plugin.settings.get_auth_alerts.ts
packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts
packages/plugins/src/registry
packages/plugins/src/entitlements
packages/plugins/src/oauth
packages/plugins/src/credentials
packages/plugins/src/vault
packages/plugins/src/environments
packages/oxagen/src/plugins
packages/inngest-functions/src/functions/plugin.catalog-sync.ts
packages/database/src/schema/plugin.ts
apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/marketplace
packages/ingestion/src/pipeline.ts
packages/ingestion/src/connectors/index.ts
packages/ingestion/src/connectors/github
packages/ingestion/src/connectors/linear
packages/ingestion/src/connectors/custom-sql
packages/ingestion/src/connectors/custom-webhook
packages/ingestion/src/connectors/google
packages/ingestion/src/connectors/zoom
packages/ingestion/src/connectors/slack
packages/ingestion/src/connectors/salesforce
packages/ingestion/src/connectors/microsoft
packages/ingestion/src/connectors/stripe
packages/ingestion/src/connectors/zendesk
packages/oxagen/src/contracts/environment.create.ts
packages/oxagen/src/contracts/environment.update.ts
packages/oxagen/src/contracts/environment.delete.ts
packages/oxagen/src/contracts/environment.get.ts
packages/oxagen/src/contracts/environment.list.ts
packages/oxagen/src/contracts/environment.set_default.ts
packages/oxagen/src/contracts/agent.environment.bind.ts
packages/oxagen/src/contracts/agent.environment.unbind.ts
packages/oxagen/src/contracts/agent.environment.list.ts
packages/database/src/schema/environments.ts
apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/workbench/environments
packages/oxagen/src/contracts/prompt.settings.read.ts
packages/oxagen/src/contracts/prompt.settings.write.ts
packages/oxagen/src/contracts/secret.import_env.ts
packages/oxagen/src/contracts/secret.export.ts
packages/oxagen/src/contracts/secret.reveal.ts
packages/oxagen/src/contracts/agent.memory_import.parse.ts
packages/oxagen/src/contracts/agent.memory_import.commit.ts
packages/oxagen/src/contracts/repo.pr.get.ts
packages/oxagen/src/contracts/repo.pr.diff.ts
packages/oxagen/src/contracts/repo.branch.list.ts
packages/oxagen/src/contracts/repo.ci.status.ts
packages/oxagen/src/contracts/asset.upload.ts
packages/oxagen/src/contracts/org.settings.read.ts
packages/oxagen/src/contracts/workspace.settings.read.ts
packages/oxagen/src/contracts/connection.get.ts
packages/oxagen/src/contracts/connection.mappings.get.ts
packages/oxagen/src/contracts/agent.memory_policy.read.ts
packages/oxagen/src/contracts/router.policy.get.ts
```


## 15. Completion and replay UI deferred (2026-09-20)

[ADR-130](docs/adr/ADR-130-spend-and-operator-feedback-ui.md) removes completion, witness, proof, and scores from the app's current presentation. The chain and replay components remain in place with their tests and backend contracts:

- `apps/app/src/features/run/chain.tsx`
- `apps/app/src/features/run/replay-actions.tsx`
- `apps/app/src/ui/replay-grade.tsx`
- `forkRun` and `bisectRuns` in `apps/app/src/features/run/actions.ts`
- `ChainCheckpoint` in `apps/app/src/data/contracts/run.ts`

The app's Knip configuration excludes only these retained files from unused-file reporting. The three retained exports carry `@deregistered`. They still compile and their tests remain. No production route imports the components. The shrink-only baseline stays empty.
