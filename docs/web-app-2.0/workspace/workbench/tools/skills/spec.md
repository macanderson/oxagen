---
# Skills

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/tools/skills` (list) and `.../workbench/tools/skills/[skillSlug]` (detail)
- **Nav location:** workspace → Workbench → tab "Tools" → sub-tab "Skills"
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
Manage the workspace's installed and authored skills — reusable, versioned procedures an agent can invoke — from install/search through AI-assisted authoring, versioning, and activation. This is the authoring counterpart to the read-only Tools catalog.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder
- **JTBD:**
  - See which skills are installed, their source, version, last-used time, and usage count
  - Draft a new skill from a plain-language description via AI
  - Review version history for a skill and roll forward by editing to a new version
  - Activate a specific version and export/download a skill definition

## Functionality
- List page: table columns Name · Source (marketplace/authored) · Version · Last used · Usage count; row click → detail.
- "New skill" wizard: description input → AI draft → review/edit → save.
- Detail page (`[skillSlug]`): version history list (version, author, created date, active flag); "Edit → new version" action; "Activate" on any prior version; Export/Download.

## Capabilities invoked
- `skill.workspace.list` (`list_workspace_skills`) — populate the list.
- `skill.workspace.install` (`install_skill`) — install from marketplace.
- `skill.metrics.read` (`get_skill_metrics`) — last-used/usage-count columns.
- `skill.draft` (`draft_skill`) — AI draft from description.
- `skill.author` (`author_skill`), `skill.create` (`create_skill`), `skill.edit` (`edit_skill`) — authoring/edit-to-new-version.
- `skill.enable` (`set_skill_enabled`) — activate/deactivate.
- `skill.version.get` / `.list` / `.upload` / `.activate` — version history and activation.
- `skill.export` (`export_skill`) — download.

## Data sources
Postgres (skills, skill_versions); ClickHouse (usage metrics via `get_skill_metrics`).

## States
- **Empty:** no skills installed — CTA to browse marketplace or draft one with AI.
- **Loading:** table skeleton on list; version-history skeleton on detail.
- **Error:** inline retry on list/metrics fetch failure; draft/author failures surface in the wizard step, not full-page.

## Existing implementation
- **Today:** list COMPLETE (source/version/last-used/usage-count columns, AI-drafted New skill wizard); `[skillSlug]` COMPLETE (version history, edit-to-new-version, activate, export/download). Legacy redirect shims at `workbench/skills` and `settings/skills` point here — collapse those routes once callers are updated.

## Vision alignment
Skills are versioned, reusable procedure contracts equipped onto agents — part of the typed-contract governance wedge and a resellable unit alongside agents themselves.
