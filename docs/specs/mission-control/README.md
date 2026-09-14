# Mission Control

The specification and implementation plan for the `apps/app` rebuild (the
Mission Control app), carried in the repo so they survive the mockups
repository. The mockups they render live in a separate repository.

| File | What it is |
|---|---|
| `spec.md` | The product and technical specification: vocabulary, architecture, the ten pages (§14, App. F), target tables (App. A), the demo scenarios (§19). |
| `plan.md` | The implementation plan: how the ten pages become the new Next.js `apps/app` beside `apps/app_deprecated` — wireframe review, page-to-data mapping, toolchain, code, and the parallel build batches (B0–B5). |
| `plan.html` | `plan.md` rendered as a page (2026-09-12, the `mc-baseline-w3` revision). `plan.md` is the source; regenerate this when the plan changes. |

Sources and copies:

- Mockups: https://github.com/macanderson/tmp-oxagen-mockups — `mc.html` (The Ten Pages) is the reference implementation the plan builds from; `w1`–`w13` are the per-flow walkthroughs. The `docs/` folder there carries the same spec and plan under their dated names; when one changes, change both.
- Oxagen Desktop (the installer app) is specified separately in `docs/specs/oxagen-desktop/`.
- `docs/mission-control/PLAN.md`, `TOOL-MATRIX.md` and `TRACEABILITY.md` are the build-time decision log and traceability over this spec; they do not restate it.
- Build tracking: integration branch `app-rebuild`, PR #2894.
