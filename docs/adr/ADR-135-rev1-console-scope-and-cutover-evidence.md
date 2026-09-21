# ADR-135: Rev1 console scope and cutover evidence

- **Status:** Accepted decisions consolidated from the maintainer record
- **Date:** 2026-09-20
- **Related:** #2949, ADR-056, ADR-065, ADR-113, `apps/app/ARCHITECTURE.md` §9, `apps/app/architecture.worklist.json` `openQuestions`

## Context

The foundation issue still asks for decisions that the maintainer already recorded in the architecture worklist. It also asks to delete the deprecated app, while the delivery plan explicitly retains it. This record collects the existing decisions and identifies the evidence needed to close the foundation issue. It grants no new scope.

## Decisions

The maintainer confirmed deletion of the runtime fixture adapter on 2026-09-15. Development and end-to-end checks use a seeded real stack through package APIs. The CI-only auth relaxation belongs in `packages/auth`; production app code has no fixture mode.

The 2026-09-14 scope review and subsequent decisions allowed unbuilt pages to display a single NotRecorded state until their retained feature issue lands. An unbacked section inside a page renders nothing. Ontology has no app route; Audit returned under #3097. This is a staged delivery rule, not permission to substitute fictional records for data.

The end-to-end suite contains exactly `login`, `pay`, and `page-load`. Component and action tests prove the other flows. The page-load test covers the route oracle on a production build; each route addition updates that oracle. Architecture probes enforce the boundary and the absence of fixture code.

The kernel boots IAM in the app, and handlers must enforce their declared role restrictions with `assertOrgRole`, including on tiers whose kernel IAM allows access. Read paths use `kernelRead`; writes use `kernelWrite`; the allowlisted tenancy lookups remain read-only.

The rebuilt app is `apps/app`, and parity tooling points there. `apps/app_deprecated` stays unbuilt and undeployed, but linted and typechecked, as required by `docs/specs/mission-control/plan.md` §5. It contains retained, deregistered features. Deleting it requires an ADR that names those features. The old WL-53 deletion request does not override this retention decision.

## Evidence and limits

The source contains the viewer and kernel seams, architecture probes, three end-to-end specs, route oracle and new capability UI map. CI runs the full checks; the shared development machine does not run the suite.

A read-only production browser visit on 2026-09-20, in an existing signed-in session, reached Fleet, Agents, Tools, Steering, Spend, Organization and Audit under the Oxagen organization and Product workspace. Every page rendered its own heading and matching ` · Oxagen` browser title. Fleet displayed recorded runs; Tools and Steering displayed their empty states. No production records, permissions or credentials were changed. This confirms those deployed routes, not every role, every route or every feature's completion criteria.

The historical issue checkboxes must be reconciled against these decisions and linked CI results individually. Neither this record nor a successful deployment closes the remaining page-specific issues.
