# ADR-008 — Skills as filesystem-first with DB augmentation

**Date:** 2026-05-28
**Status:** Accepted, retired by ADR-043; amended 2026-09-18 by ADR-093 (see the amendment at the end: what this ADR describes does not exist)
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

## Amendment 2026-09-18: what this ADR describes does not exist; skills are governed files under Steering

Maintainer decision of 2026-09-18, recorded in ADR-093 §6 and ADR-092 §5.

Checked at `main` `02278c913`: there is no `packages/skills`, no `agent.skills`
or `agent.skill_versions` table, and no loader. ADR-043 retired them with the
runtime. The only skills data in the tree is `tacho.sessions.skills_available`,
an inventory of the names a harness reported. The text above is kept as the
record of what was decided in May. It does not describe this repository.

The changed sentence. Where this ADR says "Skills live on the **filesystem**
first (`packages/skills/skills/`) and are **augmented** by tenant-defined skills
in `agent.skills`", the decision in force is: **skills are steering, and they
are files. Governed like a record through a pull request, delivered by sync
(materializing files in the checkout), loaded by the harness's own progressive
disclosure. The skill's description line competes in the assembler like any
other item. Skills live under Steering.**

ADR-090 governs resolution (`.oxagen/skills.toml`, `search_skills`, withholding
before ranking). ADR-093 governs delivery and the description line. The two are
reconciled in ADR-090's amendment of the same date.
