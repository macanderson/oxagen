# ADR-008 — Skills as filesystem-first with DB augmentation

**Date:** 2026-05-28
**Status:** Accepted
**Epic:** Agent Runtime

## Context

The agent needs discoverable, file-based prompts the way Claude Code
loads skills. Tenants also need to define their own skills inside the
product.

## Decision

Skills live on the **filesystem** first (`packages/skills/skills/`)
and are **augmented** by tenant-defined skills in `agent.skills` +
`agent.skill_versions`. The loader merges both sources at query time;
filesystem skills win on slug collision (built-ins are authoritative).

Skill format mirrors the `oxagen-feature.skill` bundle: Markdown body
+ YAML frontmatter (`name`, `description`, `metadata`).

## Alternatives considered

- **DB-only.** Tenants get full control but built-ins lose source
  control and code-review provenance.
- **Filesystem-only.** No tenant customization; every skill change is a
  deploy.
- **Marketplace from day one.** Premature; we don't have a tenant base
  to discover from yet.

## Consequences

- `packages/skills/src/loader.ts` parses `.skill.md` files into a
  typed `Skill` shape with lazy reference loading.
- `packages/skills/src/registry.ts` exposes
  `createSkillRegistry({ fsRoot, dbAdapter? })` — the DB adapter is a
  function pointer so `packages/skills` carries zero DB deps.
- Built-in skills shipped: `coding`, `debugging`, `summarization`.
- Tenant skills versioned via `version_mixin` for replay determinism.
- Future marketplace UI is additive: it writes into `agent.skills`
  and inherits the existing loader behavior.
