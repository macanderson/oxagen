# Oxagen Mission Control

The specification and implementation plan for the `apps/app` rebuild (the
Mission Control app), carried in the repo so they survive the mockups
repository. The mockups they render live in a separate repository.

| File | What it is |
|---|---|
| `spec.md` | The product and technical specification: vocabulary, architecture, the ten pages (§14, App. F), target tables (App. A), and the demo scenarios (§19). |
| `plan.md` | The implementation plan: how the ten pages become the new Next.js `apps/app` beside `apps/app_deprecated`. Wireframe review, page-to-data mapping, toolchain, code, and the parallel build batches (B0 to B5). |
| `spec.html`, `plan.html` | The markdown rendered as pages in the house document shell (`docs/specs/_house/`). The markdown is the source; run `python3 docs/specs/_house/render.py <file>.md` after a change. |

Sources and copies:

- The canonical copies live in `~/Documents/Oxagen/Specs/` under their dated
  names, and the mockups repository (https://github.com/macanderson/tmp-oxagen-mockups,
  `docs/`) carries the same files. `mc.html` there (The Ten Pages) is the
  reference implementation the plan builds from; `w1` to `w13` are the per-flow
  walkthroughs. When one copy changes, change all three.
- Oxagen Desktop (the installer app) is specified separately in `docs/specs/oxagen-desktop/`.
- `docs/mission-control/PLAN.md`, `TOOL-MATRIX.md`, and `TRACEABILITY.md` are the
  build-time decision log and traceability over this spec; they do not restate it.
- Build tracking: integration branch `app-rebuild`, PR #2894.
