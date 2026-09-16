# ADR-068: Tools: classification vocabulary, assurance hosting, observed-schema source

**Status:** Accepted (2026-09-15)
**Issue:** #2958 (backend half). Refines the Mission Control spec §6.4, §6.8, §6.9 part 1, §6.11 and App. A.5 for what the tree holds today.

## Context

The Tools lane builds the registry with its safety classification, the credential broker's grant log, and kill switches at every level of spec §6.11. The issue leaves three decisions to the maintainer and records a recommendation for each; the scope note of 2026-09-14 cuts the published assurance suite and the observed-schema proposal workflow. The tree holds the tool registry as `agent.tools` / `agent.tool_versions` and the MCP surface as `mcp.mcp_servers` / `mcp.credentials`, and no `tools` Postgres schema. `iam.emergency_denies` exists, typed as a capability deny or a resource-scope deny, with an AFTER trigger that bumps `iam.authorization_deny_generations` in the same transaction; nothing wrote to it, and the resource-scope form never matched because the kernel derived no digest for it (#1261).

## Decisions

### 1. Classification vocabulary

Adopted as the issue recommends. A tool version's safety classification is one `classification jsonb` on `agent.tool_versions`, validated on the way in by `toolClassificationSchema` (`packages/oxagen/src/contracts/tool.classification.ts`): a side-effect class (`read`, `write`, `irreversible`), an egress class (`local`, `org_tenant`, `third_party`), consequence tags, measures and data classes. The risk grade the classifier sets is carried beside the object on the wire and stored on `classified_risk_grade`; the existing `risk_grade` stays the declared grade the version's checksum covers, so a reclassification never makes an unchanged manifest look changed. `list_tool_versions` reports the classified grade when one is set.

The consequence-tag starter set is the spec's: `moves_money`, `destroys_data`, `alters_production`, `communicates_externally`, `changes_access`, `changes_entitlement`. A customer extends it with any tag matching `^[a-z][a-z0-9_]{1,63}$`; the schema admits the pattern and not the list, so a customer tag needs no code change. Measures are JSONPath-shaped paths into the call's input, each with a type (`money`, `count`, `identifier`, `environment`, `table`, `text`); a money measure names the path to its currency.

Classification describes the tool and decides nothing by itself. A class kill switch matches a version by its tags at call time, so a tool imported and tagged after the switch was flipped is stopped by it. Two rules keep that true. A new version starts with the classification of the version it replaces (`publishTool` reads it back from the row it demotes, in the same transaction), so a server shipping a changed descriptor does not take the tool out of a switch's reach. A changed classification bumps the deny generation in the writer's transaction through the trigger function `iam.emergency_denies` uses (`tool_versions_classification_deny_generation`), so a gate that loaded the tags earlier in the turn reloads them. Who classified a version, when and why land beside the object (`classified_by_user_id`, `classified_at`, `classification_reason`), and every reclassification is a `tool.classification_changed` security event.

### 2. Assurance suite hosting

Cut for this release by the scope note (the published assurance suite and the `run_assurance`, `get_assurance_result`, `export_assurance_bundle` contracts do not land). The recommendation stands for when it returns: the adversarial cases run in CI per release first; an on-demand run against a customer's deployment needs a rig (`needs:rig`). This lane adds nothing toward it.

### 3. Observed-schema source

The proposal workflow is cut by the scope note (observed schemas may be recorded, not reviewed). The recommendation stands: when observed output schemas are recorded, they are inferred from recorded tool outputs — the run recorder's frame bodies (#2952) — by a job that writes them, and the gateway path arrives with the proxy decision in the run-controls lane. `agent.tool_versions.schema_origin` therefore admits `declared` (a hand-authored manifest, `publish_tool_declaration`) and `imported` (a server's pinned `tools/list`, `import_tools`) today; the `observed` origin and its `output_schema_observed` column land with the job that writes them, so no column exists without a writer.

### 4. The digest a kill switch is matched by

A kill switch is an `iam.emergency_denies` row that names its target (`target_kind`, `target_id`, `flipped_by_user_id`) beside the typed deny the live checks match. A tool version becomes a `capability` deny on the id its calls are governed under (`mcp.<server uuid>.<tool>` for an imported tool, the slug for a declared one). Every other kind becomes a `resource_scope` deny over `resourceScopeDigestOf({ kind, id })` (`packages/iam/src/resource-scope.ts`): `sha256:` over the JCS form of `{ id, kind }`, with the id fixed per kind to the value a call has in hand at the boundary — the server's internal id, the connection's internal id, the agent's public `agt_…` id, the operator's user id, the workspace and organisation ids, the consequence tag. The kernel's agent-run check derives the audit target's digest and the organisation, workspace, agent and operator digests (#1261); the tool gateway's gate adds the server, the connection and the version's tags. One function on both sides is what makes a switch for `{kind, id}` unable to miss the call that targets `{kind, id}`.

### 5. Where the boundary is

A flip bumps the deny generation in its own transaction (the existing trigger); the handler reads the vector back on the same transaction and returns it. The tool gateway (`materializeTools`) holds the switches it last saw and the generation it saw them under; before a non-read-only call runs it re-reads the generation and reloads the switches when it moved (spec §7.4, last row). A read-only call is checked against the last-read switches. The kernel's agent-run check re-reads on every call already and keys its cache by the generation.

### 6. Placement of the grant log and the connection revocation

`mcp.credential_grants` rather than a new `tools` schema: the connection it names is `mcp.credentials`, and the default privileges and RLS policy class of the `mcp` schema apply to it with no new grants. The row keeps the connection's public id at mint time because a revoked credential's row is deleted and the log keeps naming it. Deleting a credential and flipping a connection switch on both revoke the connection's live grants in the same transaction as their own write. The gateway asks the turn's kill-switch gate about each server and the connection it would be reached with before anything reaches the server, and records the grant before the credential is presented, so a switched connection mints no grant and no credential use goes unrecorded.

### 7. The pull-request path of `import_tools`

`import_tools` registers directly. The mockup's path — declarations written to `.oxagen/tools/` on a branch, a pull request opened — needs a bound repository, and no capability records a `repository_binding_heads` row today. The path lands with the lane that binds one; until then the handler has no branch to write and nothing that could reach a default branch.

### 8. The six contracts carry an MCP tool; an API key acts as its creator

Every handler in this lane runs `assertOrgRole` (`packages/iam/src/org-role.ts`). The MCP surface authenticates with an API key only and builds every `CapabilityContext` with `userId: null` (`apps/mcp/src/context.ts`). Each handler resolves the acting user with `resolveActingUserId` (the signed-in user, or the key's creator, `auth.api_keys.created_by_user_id`) and passes that user to the gate and records it as the actor, so a key acts with its creator's current org role and no more (#3063, apps/app/ARCHITECTURE.md §9). The contracts declare `surfaces: ["api", "mcp"]` (`set_kill_switch` also `"agent"`) with an `mcp` layer, and each has a tool under `apps/mcp/src/tools/`. An earlier revision of this ADR left the MCP surface out pending that decision.

## Consequences

- Six contracts: `list_tool_versions`, `set_tool_classification`, `import_tools`, `list_credential_grants`, `set_kill_switch`, `list_kill_switches`, each with a handler, an API route, an MCP tool and a doc (decision 8).
- Two security events: `tool.kill_switch_flipped`, `tool.classification_changed`.
- A resource-scope emergency deny matches the call it names (#1261). The kernel's agent-run check now also answers to organisation, workspace, agent and operator switches with no per-contract declaration.
- The "off" flip of a kill switch records who cleared it (`updated_by_user_id`), when (`deactivated_at`) and why (`cleared_reason`, required on a cleared switch by `emergency_denies_cleared_reason_check`). `tool.kill_switch_flipped` and `tool.classification_changed` carry the actor and the capability; the target, direction and reasons are on the rows. A flip that changes nothing emits no event.
- `apps/app/ARCHITECTURE.md` §1.3 keeps Halt as the rev1 governance write; the Tools page's app half binds these contracts.
