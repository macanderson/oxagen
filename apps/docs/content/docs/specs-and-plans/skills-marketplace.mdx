---
title: "Skills Marketplace"
description: "Archived spec & plan — status: partially shipped (audited 2026-07-03)."
---

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Skills Marketplace spec is partially shipped with core data model (versioning, workspace-owned copies, seeding) and API/MCP layer functional, along with in-app management UI at Settings > Skills. The marketplace integration allows browsing agent_skill plugins. However, CLI commands are entirely absent, several required API capabilities (skill.list/get/delete/disable/marketplace.list/publish) are missing, and telemetry events are not yet recorded. The spec itself declares "Draft — not yet in active implementation."

**Implementation evidence**

- packages/database/atlas/migrations/20260619043301_skills_active_version_and_usage.sql — database schema for versioning and active version pinning
- packages/skills/src/seed.ts — workspace seeding job for builtin skills
- packages/oxagen/src/contracts/skill.*.ts — 14 skill contracts (create, edit, export, enable, workspace.list, version.list/get/upload/activate, workspace.install, author, metrics.read, agent.skill.list/load)
- apps/api/src/routes/v1/skill.*.ts — corresponding API routes mounted
- apps/mcp/src/tools/skill.*.ts — corresponding MCP tools
- apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/skills/ — UI surfaces (skills-panel, skill-detail-panel)
- apps/app/src/components/plugins/marketplace-modal.tsx (line 84) — agent_skill tab in marketplace
- packages/skills/skills/*.skill.md — template skills (coding, debugging, summarization, etc.)

**Known gaps at time of archive**

- CLI commands for skills — no skill subcommand at all (skill list/get/create/edit/delete/export/enable/disable)
- CLI sync commands — skill pull/push not implemented
- API capabilities — skill.list, skill.get, skill.delete, skill.disable contracts
- Marketplace capabilities — skill.marketplace.list, skill.marketplace.publish contracts
- Telemetry events — skill.loaded, skill.invoked, skill.version_activated, skill.installed events not recorded to ClickHouse
- UI telemetry tab (spec §5.4) — metrics.read contract exists but telemetry tab not wired
- Community skills publishing flow — marketplace publish UX not implemented
- Bulk actions UI — bulk enable/disable/export not in detail view
- Version archiving UI — archiving functionality not exposed in version history tab

**Source documents** (archived verbatim below)

- `docs/specs/skills-marketplace/README.md`
- `docs/specs/skills-marketplace/SPEC.md`

## Document — `README.md`

## Skills Marketplace & Workspace Skill Management

**Parent ticket:** OXA-1733
**Status:** Draft spec — not yet in active implementation

---

### What this is

This directory contains the product specification for the Skills Marketplace and in-app skill management surface. It covers:

- Installable skills as a first-class `agent_skill` plugin type in the marketplace
- Workspace-seeded editable copies of built-in skill templates
- Immutable version history with an explicit pinned active version
- In-app management UI (browse, edit, version, rollback)
- Cross-surface capability parity (app / API / MCP / CLI)
- Telemetry foundation (load events, token burn, latency, last-used)

### Documents

| File | Description |
|------|-------------|
| [SPEC.md](./SPEC.md) | Full product and engineering spec — start here |

### Related

- [ADR-008 — Skills filesystem-first](../../adr/ADR-008-skills-filesystem-first.md)
- [ADR-013 — Oxagen Plugins capability packs](../../adr/ADR-013-oxagen-plugins-capability-packs.md)
- [Playbook Designer SPEC](../playbook-designer/SPEC.md) — marketplace pattern reference

## Spec — `SPEC.md`

## Skills Marketplace & Workspace Skill Management — Product Spec

> **Status**: Draft
> **Author**: Product & Engineering
> **Created**: 2026-06-18
> **Parent ticket**: OXA-1733
> **Related ADR**: ADR-008-skills-filesystem-first

---

### 1. Summary

The Skills Marketplace introduces skills as a first-class installable artifact in the Oxagen platform. It extends the existing filesystem-first skill loader (ADR-008) with:

1. A **marketplace tab** in the plugin browser where `agent_skill` plugin packages are discoverable, rated, and one-click installable
2. **Workspace-owned editable copies** of skills that are seeded from built-in templates at workspace creation — not shared references to immutable builtins
3. A **version history** where every edit to a skill body or metadata creates a new immutable version; a single "pinned active version" governs what agents see
4. An **in-app management UI** for browsing, editing, enabling/disabling, and rolling back skill versions per workspace
5. A **telemetry foundation** that records load events, token burn, latency, and last-used timestamps per skill+version+workspace — without composite scores or leaderboards

This spec is deliberately implementation-free. It defines what the system does and how users experience it. Storage schema, file paths, and migration DDL are deferred to engineering tickets.

---

### 2. Core Concepts

#### 2.1 Template

A **template** is the platform-canonical definition of a skill. Templates ship in the repository (`packages/skills/skills/`) as `.skill.md` files with YAML frontmatter. They are:

- Reviewed via pull request like code
- Immutable once merged (any fix creates a new template version in source control)
- Authoritative on slug collision: if both a template and a tenant-defined skill share a slug, the template wins for agents that use the builtin registry

Templates are not directly editable by workspace members. They are the seed source for workspace-owned copies.

#### 2.2 Installed Skill (workspace-owned copy)

When a skill is "installed" in a workspace — whether via workspace creation seeding, marketplace install, or explicit import — a **workspace-owned copy** is created in the `agent.skills` table, tagged `source = 'tenant'`. This copy:

- Is fully editable by workspace members with the `skill.edit` permission
- Has its own version history, independent of the template's source-control history
- Does not track upstream template changes (fork semantics, same as Marketplace playbooks)
- Persists even if the upstream template is removed from the repository

The platform's skill loader merges filesystem-resident templates (builtins) with workspace-owned copies. For slug collisions, builtins win.

#### 2.3 Immutable Version

Every installed skill has one or more **immutable versions** stored in `agent.skill_versions`. Once a version is created it is never mutated:

- The version body (Markdown + system-prompt text), frontmatter, and references snapshot are frozen at creation
- Deleting a version is not permitted; archiving hides it from the active-version picker without removing audit history
- The version number is a monotonically incrementing integer per skill, assigned by the system

#### 2.4 Pinned Active Version

Each installed skill has exactly one **pinned active version** at any point in time. This is the version agents load when the skill is invoked.

- "Pinned" is decoupled from "latest": editing a skill creates a new latest version but does not automatically activate it
- Workspace owners/admins explicitly promote a version to active after review
- Rollback is free: pinning any prior version is the rollback path
- The active-version pointer is tracked with who made the change and when (see §5)

---

### 3. Marketplace Support

#### 3.1 Skills as `agent_skill` Plugin Type

Skills are exposed in the plugin marketplace under the `agent_skill` plugin type. The existing plugin manifest/entitlement infrastructure (OXA-1701/ADR-013) already defines `plugin_type` as an extension point; `agent_skill` is a new first-class value alongside existing types.

An `agent_skill` marketplace entry includes:

| Field | Description |
|-------|-------------|
| `slug` | Unique skill identifier (kebab-case) |
| `name` | Display name |
| `description` | Short pitch (≤ 200 chars) |
| `long_description` | Markdown body for the detail page |
| `category` | Taxonomy tag (e.g. `coding`, `research`, `data-analysis`) |
| `tags` | Free-form searchable tags |
| `publisher` | `oxagen` (platform) or org name (community) |
| `is_verified` | Oxagen-reviewed badge |
| `is_featured` | Editorially promoted |
| `install_count` | Across all workspaces (display only) |
| `preview_body` | Truncated skill body for the preview pane |
| `current_version` | Semver string from the template |
| `requires_capability` | Optional list of capability slugs the skill invokes |
| `requires_entitlement` | Optional entitlement pack slug required to use the skill |

#### 3.2 Browse & Discovery

The marketplace Skills tab provides:

- **Search** by name, tag, or description (full-text)
- **Category filter** (multi-select)
- **Publisher filter** (platform / community / my org)
- **Verified-only toggle**
- **Sort**: featured first, alphabetical, most installed

#### 3.3 Install Flow

Clicking Install on a marketplace listing:

1. Confirms the target workspace (where the user has `skill.install` permission)
2. Creates a workspace-owned copy of the skill at the current template version
3. Sets the initial active version to that copy's first version
4. Emits a `skill.installed` event to ClickHouse for telemetry
5. Redirects to the skill management page for the installed skill

Installs are idempotent: installing a skill already present in the workspace opens the management page instead of creating a duplicate.

#### 3.4 Publishing to the Marketplace (Community Skills)

Workspace owners may publish a skill they have authored to the community marketplace:

1. The skill must have at least one published (active) version
2. Publisher reviews the preview and sets category + tags
3. Submission goes into a **pending review** state; Oxagen team verifies before granting the `is_verified` badge
4. Unverified community listings are still browsable, but shown with a caution indicator
5. The publisher may unpublish at any time; existing workspace-owned copies are unaffected (fork semantics)

---

### 4. Workspace Seeding

#### 4.1 Seeding Philosophy

On workspace creation, the platform seeds a curated set of built-in skills as **editable workspace-owned copies**. These are not read-only references to the filesystem — they are full tenant copies that workspace members can modify, version, and own from day one.

This design means:

- Platform skill updates (new template versions) do not silently alter what agents use in existing workspaces
- Workspace members can diverge from the platform template without needing a fork action
- The audit trail covers all changes from the seed onward

#### 4.2 Seed Set

The seed set is defined by the platform team in the repository. At initial rollout it includes:

| Skill Slug | Purpose |
|------------|---------|
| `coding` | General software development guidance |
| `debugging` | Systematic fault diagnosis |
| `summarization` | Content distillation and abstract writing |
| `research` | Web and document-grounded research tasks |
| `data-analysis` | Structured data reasoning and insight extraction |

Additional skills may be added to the seed set in future platform releases. Existing workspaces are not retroactively seeded — additions are opt-in via the marketplace.

#### 4.3 Seed Mechanics

A workspace creation event triggers a seeding job that:

1. Reads each seed skill from the filesystem template
2. Creates an `agent.skills` row with `source = 'tenant'` for each
3. Creates an `agent.skill_versions` row capturing the template body and frontmatter at the current version
4. Pins that version as active
5. Emits a `skill.seeded` event per skill to ClickHouse

The seeding job is idempotent: re-running it on an existing workspace skips skills already present (matched by slug).

---

### 5. In-App Management UI

#### 5.1 Skills Management Page

Accessible at `/{org}/{workspace}/settings/skills`. Displays a searchable, filterable list of all skills installed in the workspace.

Each row in the list shows:

- Skill name and slug
- Current active version number
- Enabled/disabled toggle
- Last used timestamp
- Quick actions: Edit, Version History, Disable/Enable

#### 5.2 Skill Detail View

Selecting a skill opens a detail view with tabs:

**Overview tab**
- Name, description, category, tags (all editable inline)
- Enabled toggle with confirmation for disable actions
- "Edit body" entry point (opens the editor)
- Active version badge with "Change version" action

**Editor tab**
- Full Markdown editor for the skill body
- YAML frontmatter editor (name, description, metadata keys)
- "Save as new version" button — saving always creates a new version, never mutates existing ones
- Version comparison: diff view against the currently active version
- "Publish (pin)" button to make the saved version active, distinct from saving

**Version History tab**
- Chronological list of all versions (newest first)
- Each entry shows: version number, created-by user, created-at timestamp, status (active / archived)
- "Activate" action to pin any prior version
- "Diff" action to compare any two versions side-by-side
- "Archive" action to hide stale versions (does not delete)

**Telemetry tab** (see §7)

#### 5.3 Bulk Actions

The skills list supports bulk actions for workspace admins:

- Enable selected
- Disable selected
- Export selected (as `.skill.md` files in a zip)

#### 5.4 Import

Workspace admins can import a skill from a `.skill.md` file:

- File is validated against the frontmatter schema before import
- If a skill with the same slug exists, the import creates a new version on the existing skill (does not duplicate)
- If the slug is new, a new skill entry is created

---

### 6. Versioning Behavior

#### 6.1 Every Edit Creates a New Version

There is no "draft" state and no in-place mutation of skill bodies. Every save from the editor increments the version counter and stores an immutable snapshot. This means:

- The version history is a complete audit of all changes
- There is no concept of "unsaved changes" at the persistence layer; the editor may buffer locally but persistence always commits as a version
- Two users editing the same skill concurrently each create their own version; the last to activate wins the pinned pointer (optimistic model, no merge)

#### 6.2 Active Version Semantics

The pinned active version is the single version that:

- Is loaded by the skill registry when an agent invokes the skill
- Appears as "current" in the management UI
- Is attributed in telemetry as the version that ran

Promoting a new version to active is an explicit action requiring the `skill.publish` permission (distinct from `skill.edit`). This separation ensures that authors can draft changes without immediately affecting live agent behavior.

#### 6.3 Rollback

Rollback is implemented by pinning any prior immutable version as active. There is no special rollback state — it is identical to an activation. The activation event in ClickHouse records whether it was a forward activation or a rollback (determined by comparing version numbers).

#### 6.4 Audit of Who/When

Every version creation and every active-version change records:

| Field | Description |
|-------|-------------|
| `actor_user_id` | The authenticated user who performed the action |
| `actor_user_name` | Display name snapshot at time of action |
| `action` | `version_created` or `version_activated` or `version_archived` |
| `skill_id` | Workspace-scoped skill identifier |
| `from_version` | Previous active version (for activations) |
| `to_version` | New active version (for activations) |
| `timestamp` | UTC timestamp |
| `org_id` / `workspace_id` | Tenancy context |

This audit record lives in ClickHouse (append-only telemetry). It is accessible to workspace admins via the Version History tab and exportable for SOC 2 evidence.

---

### 7. Cross-Surface Parity

Per the platform capability parity rule, every skill management action reachable from the in-app UI must also be reachable from the API, MCP, and CLI.

#### 7.1 Capability Surface Map

| Capability | App | API | MCP | CLI |
|------------|-----|-----|-----|-----|
| `skill.list` | Skills list page | GET /v1/skills | `skill_list` tool | `oxagen skill list` |
| `skill.get` | Skill detail view | GET /v1/skills/:id | `skill_get` tool | `oxagen skill get <slug>` |
| `skill.workspace.list` | Skills list page | GET /v1/skills/workspace | `skill_workspace_list` tool | `oxagen skill workspace list` |
| `skill.create` | Import UI | POST /v1/skills | `skill_create` tool | `oxagen skill import <file>` |
| `skill.update` | Editor tab | PATCH /v1/skills/:id | `skill_update` tool | `oxagen skill edit <slug>` |
| `skill.version.create` | Save in editor | POST /v1/skills/:id/versions | `skill_version_create` tool | `oxagen skill version create <slug>` |
| `skill.version.list` | Version History tab | GET /v1/skills/:id/versions | `skill_version_list` tool | `oxagen skill version list <slug>` |
| `skill.version.activate` | "Publish (pin)" button | POST /v1/skills/:id/versions/:v/activate | `skill_version_activate` tool | `oxagen skill version activate <slug> <n>` |
| `skill.enable` / `skill.disable` | Toggle in list | PATCH /v1/skills/:id/enabled | `skill_enable` / `skill_disable` tool | `oxagen skill enable/disable <slug>` |
| `skill.delete` | Settings → delete | DELETE /v1/skills/:id | `skill_delete` tool | `oxagen skill delete <slug>` |
| `skill.export` | Bulk export | GET /v1/skills/:id/export | `skill_export` tool | `oxagen skill export <slug>` |
| `skill.marketplace.list` | Marketplace tab | GET /v1/marketplace/skills | `skill_marketplace_list` tool | `oxagen marketplace skills` |
| `skill.marketplace.install` | Install button | POST /v1/marketplace/skills/:id/install | `skill_marketplace_install` tool | `oxagen marketplace install skill <id>` |
| `skill.marketplace.publish` | Publish flow | POST /v1/marketplace/skills | `skill_marketplace_publish` tool | `oxagen marketplace publish skill <slug>` |

The `skill.workspace.list` contract already exists. All others above are new and must be filed as sub-issues before implementation begins.

#### 7.2 CLI Sync Commands

The CLI provides filesystem-friendly commands for teams that prefer to author skills in their editor:

```
oxagen skill pull <slug>        # download active version as a .skill.md file
oxagen skill push <file>        # upload a .skill.md file as a new version
oxagen skill pull --all         # pull all workspace skills to ./skills/
oxagen skill push --all         # push all .skill.md files in ./skills/
```

Push and pull do not auto-activate versions; activation remains an explicit step.

---

### 8. Telemetry Foundation

#### 8.1 Scope

The telemetry layer records the raw signals needed to understand skill usage. It deliberately does not compute composite scores, rankings, or quality metrics in v1.

#### 8.2 Events Captured

All events are append-only records in ClickHouse.

**`skill.loaded`** — emitted every time a skill is fetched by the registry for agent invocation:

| Field | Type | Description |
|-------|------|-------------|
| `skill_id` | UUID | Workspace skill identifier |
| `skill_slug` | string | Human-readable identifier |
| `version_number` | integer | Version that was loaded |
| `workspace_id` | UUID | Workspace context |
| `org_id` | UUID | Org context |
| `agent_id` | UUID (nullable) | Agent that requested the skill |
| `surface` | string | `api` / `mcp` / `app` / `cli` |
| `loaded_at` | timestamp | UTC |
| `latency_ms` | integer | Time from request to skill body returned |

**`skill.invoked`** — emitted when a skill body is actually injected into an LLM prompt:

| Field | Type | Description |
|-------|------|-------------|
| All fields from `skill.loaded` | | |
| `prompt_tokens` | integer | Tokens contributed by the skill body |
| `completion_tokens` | integer | Completion tokens from that invocation |
| `model_slug` | string | Model that was called |
| `invocation_id` | UUID | Links to the broader agent invocation |

**`skill.version_activated`** — emitted on every active-version change (covers both forward promotions and rollbacks):

| Field | Type | Description |
|-------|------|-------------|
| `skill_id` | UUID | |
| `from_version` | integer | Previous active version |
| `to_version` | integer | New active version |
| `actor_user_id` | UUID | |
| `workspace_id` | UUID | |
| `org_id` | UUID | |
| `activated_at` | timestamp | |
| `is_rollback` | boolean | True when `to_version < from_version` |

**`skill.installed`** — emitted when a skill is installed from the marketplace or via workspace seeding:

| Field | Type | Description |
|-------|------|-------------|
| `skill_id` | UUID | Newly created workspace skill |
| `marketplace_listing_id` | UUID (nullable) | Source listing, null for seeded builtins |
| `workspace_id` | UUID | |
| `org_id` | UUID | |
| `installed_by_user_id` | UUID (nullable) | Null for automated seeding |
| `installed_at` | timestamp | |

#### 8.3 Derived Read-Outs (UI only, not stored)

The Version History tab and a future analytics page may compute from raw events:

- Load count per skill per version (rolling 7/30/90 days)
- Token burn per skill per workspace per billing period
- Last-used timestamp per skill (max of `skill.invoked.loaded_at`)
- Latency percentiles (p50/p95) per skill

No composite "skill health score" or cross-workspace ranking is computed or surfaced in v1.

---

### 9. UX Requirements

#### 9.1 Navigation

- Skills are discoverable under **Settings > Skills** for workspace-level management
- The **Plugins > Marketplace** tab surfaces the `agent_skill` category alongside other plugin types; no separate marketplace entry point is added
- The existing agent configuration UI may show a read-only list of active skills; the management entry point links to Settings > Skills

#### 9.2 Editor Experience

- The skill body editor must support Markdown syntax highlighting
- YAML frontmatter is shown in a separate, validated form — not as raw text
- The diff view for version comparison must show line-level additions and deletions, not just a "changed" indicator
- Saving in the editor must show the new version number immediately in the UI before navigating away

#### 9.3 Versioning UX

- The active version must be visually distinct from all other versions in the history list (e.g. a "ACTIVE" badge)
- Activating a version shows a confirmation dialog that names the version being replaced and the version being promoted
- Rollback is not labeled "rollback" in the UI — it is "Activate this version" regardless of direction to avoid alarm in routine use

#### 9.4 Marketplace UX

- The install button is disabled (with tooltip) if the user lacks `skill.install` permission in the target workspace
- After install, a success toast links to the skill management page for the installed skill
- Pending-review community submissions show a status banner in the publisher's management view

#### 9.5 Empty States

- A workspace with no skills yet (edge case after seeding fails) shows a prompt to browse the marketplace
- A skill with no active version (impossible in normal flow but possible after a failed activation) shows a warning banner with a "Activate a version" CTA

#### 9.6 Accessibility and Responsiveness

- All management UI must meet WCAG 2.1 AA
- The marketplace browse and skill list must be usable on tablet viewport widths (≥768px)
- The editor may be desktop-only (≥1024px) without a mobile fallback

---

### 10. Future Compatibility

The following capabilities are explicitly deferred from v1 but the design must not preclude them:

| Future Capability | Compatibility Requirement |
|-------------------|--------------------------|
| **Upstream sync** — optionally track template updates and offer a "sync from platform" action | Workspace copies must store the source template slug and version at install time |
| **Composite skill quality scores** — leaderboard / recommendation signals | Telemetry events must include enough raw fields; do not denormalize scores into the events table |
| **Paid marketplace listings** — publisher revenue share | The marketplace listing schema must include a `pricing_model` field (nullable, default free) |
| **Skill dependencies** — a skill that requires other skills to be active | The frontmatter `references` field (already in the types) can be extended; loader dependency resolution is additive |
| **Organization-scoped shared skills** — skills shared across workspaces within an org | The `agent.skills` table already has `org_id`; a future `scope` column (`workspace` vs `org`) is the extension point |
| **Team authoring / review flow** — draft skill changes require approval before activation | The permission separation between `skill.edit` and `skill.publish` already supports this; the approval workflow is the gate |
| **AI-assisted skill authoring** — chat UI that refines skill prompts | The editor's "Save as new version" path is the write target; no structural changes needed |

---

### 11. Open Questions

| # | Question | Options | Notes |
|---|----------|---------|-------|
| 1 | Should workspace seeding be synchronous (blocking workspace creation) or asynchronous (Inngest job)? | Synchronous (simpler) vs async (faster workspace creation) | Recommend async; workspace is usable before skills are seeded |
| 2 | What is the maximum body size for a skill version? | 32KB / 64KB / unlimited | Needs upper bound to prevent prompt-token abuse; suggest 64KB |
| 3 | Should the filesystem builtin registry be surfaced in the marketplace, or only tenant-created skills? | Builtins in marketplace vs separate browsing | Keeping builtins separate avoids confusion between "install a copy" and "already seeded" |
| 4 | When a builtin template is updated in the repository, should workspace owners be notified? | Silent / notification banner / opt-in email | Recommend in-app banner on skills list page; no auto-update |
| 5 | Should community marketplace submissions require an org verification step before any submissions are allowed? | Per-submission review only vs org pre-verification | Start with per-submission review; add org verification as abuse patterns emerge |
| 6 | Can the CLI `push` command create skills that don't exist yet (create-on-push)? | Create-on-push vs explicit `skill create` first | Create-on-push is ergonomic; add a `--create` flag to be explicit |
| 7 | Should the `skill.invoked` telemetry event be emitted inline (same request) or async (Inngest)? | Inline (simpler) vs async (lower latency impact) | Async via Inngest; follows existing telemetry patterns |
| 8 | How are skills versioned in the marketplace listing — does the listing show the latest template version or allow pinning to a specific template version on install? | Latest-at-install vs pinned listing version | Latest-at-install for simplicity; listings page shows the current template semver |

---

### 12. Acceptance Criteria

#### 12.1 Workspace Seeding

- [ ] New workspace creation results in all seed skills present in the workspace within 30 seconds
- [ ] Each seeded skill has exactly one version, pinned as active
- [ ] Re-running the seed job on an existing workspace does not create duplicate skills
- [ ] Seeding is auditable: a `skill.installed` event per skill appears in ClickHouse with `installed_by_user_id = null`

#### 12.2 Versioning

- [ ] Saving a skill body in the editor creates a new version; the previous version is unchanged and still accessible
- [ ] The active version pointer does not change until a user explicitly activates a version
- [ ] Activating any prior version (rollback) records a `skill.version_activated` event with `is_rollback = true`
- [ ] Archiving a version hides it from the default history view but does not remove it from the audit log

#### 12.3 In-App Management UI

- [ ] Workspace members with `skill.read` can view the skills list and skill detail (read-only)
- [ ] Workspace members with `skill.edit` can open the editor and save new versions but cannot activate them
- [ ] Workspace owners/admins with `skill.publish` can activate versions
- [ ] The Version History tab lists all versions with actor, timestamp, and active badge on the pinned version
- [ ] The diff view shows line-level changes between any two versions

#### 12.4 Marketplace

- [ ] The Marketplace → Skills tab loads and is searchable without errors
- [ ] Installing a skill from the marketplace creates a workspace-owned copy and redirects to the skill management page
- [ ] Installing a skill already present in the workspace does not create a duplicate; navigates to the existing skill
- [ ] A community skill submission enters pending review state; it does not appear as verified until reviewed

#### 12.5 Cross-Surface Parity

- [ ] `skill.list`, `skill.get`, `skill.version.list`, `skill.version.activate`, `skill.enable`, `skill.disable` are all callable via the REST API, MCP, and CLI and return consistent results
- [ ] `pnpm check:manifest` reports zero unmatched gaps for all `skill.*` capabilities
- [ ] CLI `oxagen skill pull <slug>` downloads the active version body as a valid `.skill.md` file
- [ ] CLI `oxagen skill push <file>` creates a new version on the matching workspace skill

#### 12.6 Telemetry

- [ ] Every agent skill invocation emits a `skill.invoked` event to ClickHouse within 5 seconds
- [ ] The Telemetry tab in the skill detail view renders load count, last-used, and token burn for the last 30 days
- [ ] No PII (user content, skill body text) is stored in ClickHouse telemetry events

---

### 13. References

- Parent ticket: OXA-1733
- ADR-008: Skills as filesystem-first with DB augmentation
- ADR-013: Oxagen Plugins capability packs
- Existing contract: `skill.workspace.list` (`packages/oxagen/src/contracts/skill.workspace.list.ts`)
- Existing schema: `agent.skills` and `agent.skill_versions` tables (`packages/database/src/schema/agent.ts`)
- Existing loader: `packages/skills/src/loader.ts`, `packages/skills/src/registry.ts`
- Related spec: [Playbook Designer SPEC](../playbook-designer/SPEC.md) — marketplace pattern reference

---

*End of spec.*

