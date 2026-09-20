# Oxagen Mission Control

> The product name Mission Control was retired on 2026-09-19 by [ADR-113](../../adr/ADR-113-workforce-management-leads-mission-control-is-retired.md); this folder keeps its name as a path, and the documents in it keep their text.

The specification and implementation plan for the `apps/app` rebuild (the
Mission Control app), carried in the repo so they survive the mockups
repository. The mockups they render live in a separate repository.

| File | What it is |
|---|---|
| `spec.md` | The product and technical specification: vocabulary, architecture, the ten pages (§14, App. F), target tables (App. A), and the demo scenarios (§19). |
| `plan.md` | The implementation plan: how the ten pages become the new Next.js `apps/app` beside `apps/app_deprecated`. Wireframe review, page-to-data mapping, toolchain, code, and the parallel build batches (B0 to B5). |
| `spec.html`, `plan.html` | The markdown rendered as pages in the house document shell (`docs/specs/_house/`). The markdown is the source; run `python3 docs/specs/_house/render.py <file>.md` after a change. |

Sources and copies:

- **The canonical copies are in the roadmap repository**
  (https://github.com/macanderson/roadmap, formerly `tmp-oxagen-mockups`):
  `docs/mission-control-spec.md` and `docs/implementation-plan.md`. They are the
  copies the mockups render, and they carry the maintainer decisions of 2026-09-14
  and 2026-09-15 that this repository's copies do not have yet. The copies here are
  carried for build agents. No build step joins the two, so a change is made in
  both by hand, in the same change set. Each file's header names the sections that
  are identical in both and the sections that still differ. The dated files in
  `~/Documents/Oxagen/Specs/` are the 2026-09-11 originals and are no longer
  canonical.
- `mockups/missioncontrol.html` in the roadmap repository is the reference
  implementation the plan builds from, and its scenarios are the per-flow
  walkthroughs.
- The review that the 2026-09-18 amendments come from is
  `docs/audits/2026-09-18-steering-graph-gateway-review.md`. Its decisions are
  ADR-091 (Phase 0, merged as PR #3289) and ADR-093 to ADR-097 (draft PR #3294).
  The epic is issue #3295. The order of build is Phase 0 merged, Phase 4 in build,
  then Phases 1, 2, 3 and 5 (`plan.md` §8).
- Oxagen Desktop (the installer app) is specified separately in `docs/specs/oxagen-desktop/`.
- `docs/mission-control/PLAN.md`, `TOOL-MATRIX.md`, and `TRACEABILITY.md` are the
  build-time decision log and traceability over this spec; they do not restate it.
- `docs/mission-control/GAP-INVENTORY.md` is the 2026-09-19 page-by-page gap
  inventory of `apps/app` against the canonical roadmap §14. Prefer it over
  `PLAN.md` / `TRACEABILITY.md` for what is built today, and read
  `docs/audits/2026-09-19-mission-control-gap-inventory-review.md` beside it:
  the review corrects the rows five same-day PRs made stale.
- `docs/mission-control/BUILD-CHUNKS.md` is the build plan that follows from
  the review: six sessions, each a `/mc-<n>-<name>` command over a workflow in
  `.claude/workflows/`.
- Build tracking: integration branch `app-rebuild`, PR #2894.
