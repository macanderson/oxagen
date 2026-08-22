# 04 — Build Plan, Ready-to-Go Prompts, and Model Selection

How to actually ship this, in what order, and which model to run each piece with. Model
picks follow the `CLAUDE.md` operating model: Haiku for single-file/lookups, Sonnet for
cross-package or non-trivial logic, Opus for architecture, security/billing, and
multi-system work. Each prompt is copy-paste ready for a subagent or a Claude Code session.

## Sequencing law (do not violate)

Per `CLAUDE.md`: **contract → API route → MCP tool → UI**. The app cannot wire to a
capability with no `/v1` route. So the 64 API-gap capabilities (schema.*, connection.*,
integration.*, repo.*, semantic.*, workflow.*) are built API-first, before their UI. And
two surfaces need net-new persistence first: **Commands** and **Prompt Templates**.

Every work package is one branch, one PR, tests + e2e, `pnpm gate` before ready, and the
`test-completeness-judge` before opening. Restate the "NEVER run all tests" rule in every
subagent prompt.

---

## Phase 0 — Foundations (the parity gate + IA shell)

These unblock and measure everything else. Do them first.

### WP-0.1 — App-layer parity gate
**Model: Opus** (cross-system: contracts + manifest checker + CI; it defines the law
everything else is measured against).

> Ready-to-go prompt:
> "You are on branch `feat/app-parity-gate`. Add an `app` layer to the capability manifest
> so CI can prove the web app exposes every operable capability. (1) Extend the contract
> schema in `packages/oxagen/src/contracts` to accept optional `appRoute?: string`,
> `appSurface?: 'route'|'command-menu'`, and `appExempt?: { reason: string }`. (2) Extend
> `tools/scripts/check-manifest` (and `pnpm check:manifest --json`) to add `app` to the
> layer vocabulary: a capability satisfies `app` when it declares an `appRoute` that
> resolves to a real path under `apps/app/src/app/`, OR is registered as a command-menu
> action, OR carries `appExempt`. (3) Add `pnpm check:parity` that prints operable
> capabilities missing an `app` surface. (4) Classify every contract Operable/Observed/
> Internal per `docs/specs/app-parity-ui-overhaul/02-information-architecture.md` Part D;
> seed `appExempt` reasons for all Internal ones. (5) Advisory CI comment first, like the
> Vision Gate. Unit-test the checker. Do NOT run the full suite; run only the checker's own
> test file. This is on-vision: governed, typed contracts with enforced parity across all
> four surfaces."

### WP-0.2 — Navigation + route shell
**Model: Sonnet** (touches `sidebar.ts`, `routes.ts`, shell components, several new route
folders; structural but not deep logic).

> Ready-to-go prompt:
> "You are on branch `feat/ia-nav-shell`. Re-populate the workspace and org sidebars per
> `docs/specs/app-parity-ui-overhaul/02-information-architecture.md` Part B. Update
> `apps/app/src/lib/sidebar.ts` (workspaceConfig, orgConfig) and `routes.ts` builders. Add
> nav groups OPERATE / Studio / Knowledge / IMPROVE / EXTEND (workspace) and GOVERN / METER
> / DEVELOP (org). Create empty `page.tsx` route stubs (with a 'coming soon' placeholder and
> the right layout/tabs) for every NEW route in Part C: `/runs`, `/fleets`, `/approvals`,
> `/studio/{agents,skills,prompts,commands,tools}`, `/marketplace`, `/knowledge/connections`,
> `/access/roles`, `/billing/reseller`. Add redirects: `/activity`→`/runs`,
> `/settings/skills`→`/studio/skills`, `/settings/prompts`→`/studio/prompts`,
> `/settings/plugins`→`/marketplace`, `/knowledge/repos`→`/knowledge/connections`. Wire the
> Approvals badge count. Add the top-right live-spend chip. Keep `@oxagen/ui`/coss-ui and the
> `@/components/ui/*` re-export convention. E2E: nav renders, every new route resolves. Run
> only `apps/app` e2e for the changed specs, never the full suite."

---

## Phase 1 — Net-new persistence (unblocks Studio)

### WP-1.1 — Prompt Template library
**Model: Opus** (new schema + contracts + API + MCP + UI; a full new capability domain,
must land governed and metered end to end).

> Ready-to-go prompt:
> "Branch `feat/prompt-templates`. Add a named, reusable system-prompt library as a first-
> class capability, distinct from the workspace-singleton `prompt.settings`. Follow the
> `oxagen-feature` skill exactly. (1) Drizzle schema `prompt.prompt_templates` +
> `prompt_template_versions` (org+workspace scoped, `versionMixin`, soft-delete): fields
> name, slug, description, category, body (mustache), variables jsonb, isLatest. Migration
> in `packages/database/atlas/migrations` with a fresh timestamp prefix later than the local
> DB head; regenerate `atlas.sum` with `atlas migrate hash`. (2) Contracts
> `prompt.template.{create,get,list,update,version.list}` with IAM `defaultRoles`, metering,
> `layers` including api/mcp/app/docs. (3) `/v1` API routes, MCP
> tools, docs in `docs/capabilities/`. (4) It must be selectable from the Agent Builder step
> ② and from Commands. Unit + e2e. Verify with a real SELECT after migration. Confirm local
> DB target (`localhost:5433`, `unset DATABASE_URL`). Do NOT run the full test suite; run
> `pnpm --filter @oxagen/database test:unit -- <file>` and the one new route test."

### WP-1.2 — Commands (slash) entity
**Model: Opus** (new schema + contracts + API + MCP + UI, and it must reach parity with the
filesystem loader; multi-system).

> Ready-to-go prompt:
> "Branch `feat/commands-entity`. Give slash commands DB-backed org/workspace persistence at
> parity with the `.oxagen/commands/*.md` filesystem loader. Follow `oxagen-feature`. (1) Schema
> `agent.commands`: trigger (e.g. 'audit'), description, agentId (nullable = inline prompt),
> promptTemplateId (nullable), argumentHint, variables mapping ($1..$9 → template vars),
> modelOverride, visibility org|workspace, enabled. (2) Contracts
> `command.{create,get,list,update,delete,run}` — `command.run` resolves the command to an
> agent+prompt+inputs and dispatches through the existing run path (reuse, do not fork the
> transport). IAM + metering. (3) `/v1` routes + MCP tools + docs. (4) The filesystem loader
> should read these too, closing the parity gap in both directions. Migration + `atlas.sum` rehash, fresh prefix. Unit + e2e. Narrow
> test runs only."

---

## Phase 2 — Close the 64 API gaps (unblocks Knowledge + Automations UI)

### WP-2.1 — schema.* API routes (~21)
**Model: Sonnet** (mechanical-ish: contracts exist, wrap them in `/v1` routes; combined route
file pattern like the existing `schema.ts`).

> "Branch `feat/api-schema-routes`. The `schema.*` contracts (list/export/setup/recommend/
> toggle/chat/label.*/property.*/relationship.*/validate.*/version.*/reconcile.*/registry.*)
> have no `/v1` route. Add one combined `apps/api/src/routes/v1/schema.ts` covering all of
> them (mirror how `connection.ts`/`repo.ts` cover a whole domain), mount in `app.ts`, each
> calling `invoke(contract.name, …)` with `@oxagen/handlers/register` imported. Verify with
> `pnpm check:manifest --json` that schema api-gaps drop to zero. Unit-test the route file.
> After editing tests, run the package typecheck (apps/api build typechecks test files).
> Narrow runs only."

### WP-2.2 — connection.* + integration.* API routes (~17)
**Model: Sonnet.** Same pattern, combined route files. Prompt mirrors WP-2.1 for the
`connection`/`integration` domains.

### WP-2.3 — repo.* + semantic.* + workflow.* API routes (~21)
**Model: Sonnet.** Same pattern. Note `repo.ts` and `semantic-edge.ts`/`semantic-
relationship.ts` combined files already exist for some; fill the genuine gaps only. Confirm
against `check:manifest --json`, do not file false-positive parity work (see CLAUDE.md
false-positive list).

---

## Phase 3 — Studio (the hero surfaces)

Build order: Tools (read-only, easy win) → Skills polish → Prompts UI → Commands UI →
Agents Builder (the big one). Agents last because it consumes all the others.

### WP-3.1 — Studio → Tools catalog
**Model: Haiku** (single read-only page over `agent.tool.list`; list + detail drawer).

> "Branch `feat/studio-tools`. Build `/studio/tools`: a searchable, filterable table over
> `agent.tool.list` (domain, risk, requiresApproval, installed-by-plugin, used-by-agents),
> row → detail drawer showing input/output schema, `defaultRoles`, and equip-count. Read
> only; link out to Access→Roles and Marketplace. `@/components/ui/*`, reablocks table. E2E
> screenshot of the catalog. Declare `appRoute` on `agent.tool.list`. Narrow tests only."

### WP-3.2 — Studio → Skills (move + polish)
**Model: Haiku** (page already exists at `settings/skills`; move to `/studio/skills`, keep
CRUD, add the New-skill form from wireframe §4).

> "Branch `feat/studio-skills`. Move the existing skills pages to `/studio/skills`
> (redirect the old path), and add the New/Edit skill form binding to `skill.create`/
> `skill.edit`/`skill.version.*` per wireframe §4 (name, slug, weight, body ≤32k,
> references, activate). E2E: create the 'Brand Voice' skill and assert it lists. Narrow
> tests."

### WP-3.3 — Studio → Prompts UI
**Model: Sonnet** (new UI over the WP-1.1 contracts; variable editor, version diff).

> "Branch `feat/studio-prompts`. Build `/studio/prompts` over the `prompt.template.*`
> contracts from WP-1.1 per wireframe §5: list, editor with mustache body + typed variables,
> version save/save-as-new, 'used by' backrefs. Keep it visually distinct from the
> workspace-singleton prompt in Settings (link between them with a one-line explainer). E2E:
> create 'Website Audit' with a {{domain}} variable. Declare `appRoute`. Narrow tests."

### WP-3.4 — Studio → Commands UI
**Model: Sonnet** (new UI over WP-1.2 contracts; agent + prompt pickers, arg mapping).

> "Branch `feat/studio-commands`. Build `/studio/commands` over `command.*` from WP-1.2 per
> wireframe §6: trigger, description, agent picker (`agent.definition.list`), prompt picker,
> argument hint, $1..$9 → variable mapping, model override, visibility, enable toggle, live
> preview. E2E: create `/audit` bound to the Auditor agent + Website Audit prompt. Assert it
> appears in the Ask composer's slash list. Declare `appRoute`. Narrow tests."

### WP-3.5 — Studio → Agents Builder  ★
**Model: Opus** (the centerpiece: multi-step builder, the uniform Equip picker across four
tool types, graph access, triggers, IAM govern step, versioning/publish; cross-package,
security-adjacent, the highest-value surface).

> Ready-to-go prompt:
> "Branch `feat/studio-agents-builder`. Build the Agent Studio: `/studio/agents` (list over
> `agent.definition.list` per wireframe §2) and `/studio/agents/[id]` (the 7-step builder per
> wireframe §3), binding 1:1 to `AgentDefinition` (`packages/oxagen/src/agent-schema.ts`) and
> `agent.definition.{create,get,update,publish}` + `agent.deploy`. Steps: ① Identity
> (name/desc/type/model — model from `workspace.model.settings`), ② Instructions (inline OR
> pick a `prompt.template` + append), ③ **Equip** — ONE picker over `AgentDefinition.
> agentTools[]` spanning `type: skill|function|mcp_server|agent`, sourced from
> `skill.workspace.list`, `agent.tool.list`, `agent.mcp.list`, and `agent.definition.list`
> (subagents); show riskLevel + requiresApproval inline per tool; 'browse marketplace' for
> uninstalled, ④ Ground (`graph` access: ontology, mode, retrieval, budget), ⑤ Triggers
> (`agent_triggers`: manual/command/schedule/event; command trigger links a `command`),
> ⑥ Govern (which roles can run via `role_grants`; approval policy), ⑦ Review & Publish
> (version diff, immutable snapshot, `agent.definition.publish`, optional deploy). Live
> preview panel + est. cost. Declare `appRoute` on the agent.definition contracts. This is
> security-adjacent (it wires tools + approvals) — add explicit `assertOrgMember`/
> `assertBillingManager` gates at call sites per CLAUDE.md (`apps/app` does not bootstrap
> IAM). Full e2e of the golden path steps 3+7 with screenshots. Consult `coss-ui`,
> `frontend-patterns`, `oxagen-feature`. Dispatch `test-completeness-judge` before the PR.
> NEVER run the full suite; run only the new agent-builder e2e spec and the touched unit
> files."

---

## Phase 4 — Operate surfaces

### WP-4.1 — Runs (rename + trace polish)
**Model: Sonnet** (rename Activity→Runs, add cost column + grounded-in citation chips +
replay; reuses existing trace UI from PR #574).

> "Branch `feat/runs`. Rename `/activity`→`/runs` (redirect), add per-run cost + token
> columns and a 'grounded' node count. In the trace view add cost per step, `NodeRef`
> grounded-in chips (cited by label, not UUID — reuse `node-ref.tsx`), a link to the raising
> Approval, and Replay (`agent.debug.trace`). Declare `appRoute` on `agent.execution.list`/
> `agent.trace.get`. Narrow tests."

### WP-4.2 — Approvals inbox
**Model: Sonnet** (new page unifying four approval sources; not deep, but cross-domain).

> "Branch `feat/approvals-inbox`. Build `/approvals` per wireframe §10 unifying
> `agent.approval_requests` (`agent.approval.resolve`), `agent_plans` (`agent.plan.approve`),
> `agent.mcp.consent` (`agent.mcp.consent.resolve`), and `semantic.*.approve` into one inbox:
> risk badge, input preview, cited endpoints by label for edge approvals, resolve/deny, bulk
> approve for low risk, link back to the Run. Live count feeds the sidebar badge. Declare
> `appRoute`. E2E: raise + resolve a tool approval. Narrow tests."

### WP-4.3 — Fleets
**Model: Sonnet** (new page over fanout lineage; reagraph tree + cost rollup).

> "Branch `feat/fleets`. Build `/fleets` (list over `agent.subagent.fanout.list`) and
> `/fleets/[id]` (tree over `agent.subagent.fanout.get` per wireframe §8) showing the root→
> subagent lineage, per-branch tokens + cost + cited-node count, running/done/waiting state,
> aggregate node, and cancel (`agent.subagent.cancel`). Use `reagraph` for the tree. Link to
> Runs. Declare `appRoute`. Narrow tests."

---

## Phase 5 — Extend + Govern + Meter

### WP-5.1 — Marketplace (promote + MCP merge)
**Model: Sonnet** (move plugins UI out to `/marketplace`, fold MCP install in as a tab,
add install-detail with contracts/tier/scopes).

> "Branch `feat/marketplace`. Promote `/settings/plugins` to `/marketplace` (Browse /
> Installed / Registries tabs) over `plugin.catalog.*`/`plugin.org.*`/`plugin.registry.*`,
> and fold the org `developer/mcp` install into an `MCP servers` tab over `agent.mcp.*`
> (catalog / custom URL / local) per wireframe §11. Install detail shows contracts claimed,
> tier/plan gate, scopes, and tool risk. Redirect old paths. Declare `appRoute`. Narrow
> tests."

### WP-5.2 — Access → Roles & grant matrix
**Model: Opus** (RBAC editor over 287 capabilities; security-critical, must not fail-open).

> "Branch `feat/access-roles`. Merge Members + Access into `/access` (People / Roles /
> Requests / Sessions / Reviews) per wireframe §13. Build the **Roles** tab: role CRUD
> (`roles`), the capability grant matrix over `role_grants` (allow/deny/require-approval per
> capability, searchable across all 287, scope org|workspace, inherit-from), and the
> **Requests** tab for JIT `access_requests` (approve/deny with TTL). Security-critical:
> deny must be explicit, default effect must not fail-open, changes must emit audit events
> (`audit.log.query` visible in Security). Add call-site IAM gates. Declare `appRoute`. E2E:
> create a role, set a deny grant, assert enforcement. `test-completeness-judge` before PR.
> Narrow tests."

### WP-5.3 — Billing → Reseller (meter-to-revenue)  ★ most on-vision
**Model: Opus** (billing + Stripe + ClickHouse metering; the core wedge, multi-system,
money-touching).

> Ready-to-go prompt:
> "Branch `feat/billing-reseller`. Build `/billing/reseller` per wireframe §14: let a
> customer turn observed agent usage into bills for THEIR customers. Read metered usage from
> the ClickHouse usage events, let them define reseller meters (markup on tokens, per-run
> price, per-tool price), map those to Stripe prices, preview an invoice, and sync
> (`pnpm billing:stripe-sync` path). This is the meter-to-revenue wedge from `docs/VISION.md`
> — revenue infrastructure, not a spend dashboard. Money-touching and multi-system: reuse the
> existing `billing.*` + `budget.*` contracts and the Stripe/ClickHouse seams; add new
> contracts only if genuinely missing, fully typed + IAM + metered. Guard with
> `assertBillingManager`. Verify against a prod-equivalent Stripe test env (webhook secret
> via full `pnpm dev`, not isolated api restart). Declare `appRoute`. E2E with a Stripe test
> customer. `test-completeness-judge` before PR. Narrow tests."

---

## Model-selection summary

| Phase | Work package | Model | Why |
|---|---|---|---|
| 0 | Parity gate | **Opus** | Cross-system law; contracts + checker + CI |
| 0 | Nav shell | Sonnet | Structural, many files, low logic depth |
| 1 | Prompt templates | **Opus** | Full new domain, all layers, migration |
| 1 | Commands entity | **Opus** | New domain + loader parity, multi-system |
| 2 | schema/connection/integration/repo/semantic/workflow API | Sonnet | Mechanical route-wrapping over existing contracts |
| 3 | Tools catalog | Haiku | Single read-only page |
| 3 | Skills move | Haiku | Existing page, small delta |
| 3 | Prompts UI | Sonnet | New UI + variable/version editor |
| 3 | Commands UI | Sonnet | New UI + pickers + arg mapping |
| 3 | **Agents Builder ★** | **Opus** | Centerpiece; equip picker, triggers, govern, publish |
| 4 | Runs | Sonnet | Rename + cost/citation polish |
| 4 | Approvals | Sonnet | Cross-domain unify |
| 4 | Fleets | Sonnet | New page + lineage tree |
| 5 | Marketplace | Sonnet | Move + MCP merge |
| 5 | Access roles matrix | **Opus** | Security-critical RBAC, no fail-open |
| 5 | **Reseller billing ★** | **Opus** | Money + Stripe + ClickHouse, the wedge |

Default to Haiku for any follow-up single-file polish. Escalate to Sonnet the moment a
package boundary is crossed or non-trivial new logic appears. Reserve Opus for the three
starred items and anything touching auth, billing, or the parity law itself.

## Definition of done (every WP)

1. Branch cut from fresh `main`, pushed immediately, PR opened (draft ok).
2. Contract → API → MCP → UI order respected; `appRoute` declared on every operable
   capability the WP touches.
3. Unit + e2e for new/changed logic; screenshots for UI success states.
4. `pnpm check:parity` shows the WP's capabilities now covered.
5. `test-completeness-judge` APPROVED (required for the starred WPs).
6. `pnpm gate` green locally, CI green via `gh run watch`.
7. Vision Gate verdict: advances (this whole effort is squarely on-wedge).
