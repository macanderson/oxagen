# ADR-255: The Work pages are walked in a real browser by a CI-only script outside the e2e suite

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** work, app
- **Related:** issue #5163 (lane P1-05), `agent-work-phase-1.html` in
  `oxageninc/roadmap` (Screens, Build plan, Release gates),
  `apps/app/ARCHITECTURE.md` §0.12, §5, §6.3, INV-07, INV-20, and INV-22,
  ADR-243, ADR-244, ADR-250, ADR-251, issue #4818 (the mockup parity
  capture), `apps/app/scripts/work-walk/`,
  `.github/workflows/work-surfaces-walk.yml`.

## Context

Lane P1-05 builds the Work pages: the Work page with its Inbox, Running,
Review, and Done tabs, one work item, Work setup, and Outcomes. The phase plan
sets what the lane must show before it hands off: "CI browser coverage for the
full workflow in both themes, keyboard use, narrow screens, stale evidence,
and role restrictions. No fixture-derived production success."

Three facts shape how that coverage can run.

1. **The e2e suite is closed.** INV-20 keeps `apps/app/e2e` at exactly three
   specs: `login`, `pay`, and `page-load`. §0.12 and §6.3 say every other flow
   is a unit or component test. A fourth spec for Work would break the
   invariant, and the next lane would have the same claim to a fifth.
2. **Component tests cannot see what the lane must prove.** They render in
   jsdom, which has no stylesheet, no layout width, and no server. They prove
   each component's states and its calls, but not a theme, a 400 px screen, a
   page's real focus order, or the server refusing a person's read.
3. **A precedent exists.** The mockup parity capture (#4818) needed a real
   browser on a production build for every page. It became two scripts under
   `apps/app/scripts/mockup-parity/` and one workflow,
   `mockup-parity-capture.yml`, that alone runs them. It is not a spec, and
   §5 lists it as CI-only tooling.

Accept also shapes the walk. Accept reads the pull request's required checks
from GitHub at the press (ADR-251, `accept.ts`), and a read that fails refuses
the acceptance. A CI job has no GitHub connection, so an Accept pressed there
can only be refused.

## Decision

1. **The Work walk is a script, not a spec.** It is two scripts in
   `apps/app/scripts/work-walk/` and one workflow,
   `.github/workflows/work-surfaces-walk.yml`, which is the only thing that
   runs them. `walk.ts` drives Chromium through Playwright's library API, the
   `chromium` export of `@playwright/test`, which the app already depends on.
   It asserts by hand and stops at the first broken check. INV-20 and §0.12
   hold as written, and `apps/app/e2e` keeps its three specs.

2. **The seed writes through package APIs, outside `src`.** `seed.ts`
   (`seed:work`) runs after `seed:e2e` and `seed:audit`. It enters one work
   item per state the Work pages draw, through the work intake library
   (`enterWorkItem`, `insertDecision`), the work record store (`saveBrief`,
   `approveBrief`, `appendFacts`), the send action (`sendWork`), the runtime
   functions (`claimWorkOrder`, `linkWorkOrderRun`, `endWorkOrderRuns`), and
   the evidence function (`evidenceFacts`). It registers two more agents with
   `register_agent` through the kernel, because one runtime holds one agent per
   harness and one agent holds one send until its run ends. Three rows have no
   package API that works without a live machine or a GitHub connection: an
   enrolled host, the host's key, and a failing GitHub collector. Those go
   through `@oxagen/database`'s typed schema in the tenant transaction, the way
   `seed:e2e` writes its retention policy. Nothing under `src` imports either
   script (INV-07, INV-22). `states.ts` holds the contract: each seeded state's
   title, tab, status, and wait, and every test id the walk presses.

3. **The walk covers what the phase plan names.** In dark and light at
   1440×1000 and in dark at 400×860, it reads each tab of the Work page, each
   seeded item on its own tab with its status and wait, Work setup's three
   tabs, Outcomes, and each seeded item's page. No Work page shows Held or
   Proven, and no page scrolls sideways at 400 px. In dark at 1440×1000 it
   moves along the tab row with the arrow keys and Enter, closes a dialog with
   Escape and checks focus goes back to the button that opened it, and enters
   a work item from the keyboard. As the owner, it approves a brief triage
   drafted, sends it, and cancels the send. It sees a failing required check
   keep Accept disabled, sees stale evidence, and sees Accept refused. It
   answers triage's question, closes an item as a duplicate, and reopens it.
   As `dana`, who holds the Billing role and no workspace role, it sees the
   Work page and an item page draw the denied state with no action on them.

4. **The walk proves Accept fails closed.** With no GitHub connection,
   Oxagen cannot read the required checks, so Accept is refused and the item
   stays in review. That refusal is the honest result, and the walk asserts
   it. `dispatch.pg.test.ts` proves an Accept that succeeds, against a GitHub
   fake inside the test, and the component tests prove the dialog's success
   path. No production code gains a way to accept without GitHub.

5. **`E2E_TEST=true` is set in two places in this workflow.** The `seed:work`
   script sets it, as `seed:e2e` and `seed:audit` do, and so does the one
   server the workflow starts. INV-22 names both.

6. **A stand-in answers Inngest.** Entering a work item sends
   `work/item.received`, and other Work writes send events too. The job runs
   no Inngest, and the SDK sends to Inngest's cloud unless told otherwise. So
   the workflow starts a small HTTP server on `127.0.0.1:8288` that answers
   every POST as Inngest's event API answers a send, and sets
   `INNGEST_EVENT_API_BASE_URL` to it for the app's server. The SDK reads that
   variable before `INNGEST_BASE_URL` (inngest 3.54.2,
   `components/Inngest.js`, `loadModeEnvVars`). Only this workflow sets it.
   Nothing consumes the events, so a new item stays in triage, and the walk
   expects that.

7. **It runs on ready pull requests that touch Work.** The trigger is a pull
   request that is not a draft and changes the Work pages, their reads, the
   work records, work intake, the Work contracts, `packages/work`, or the
   tooling. A dispatch with a `ref` walks any commit. The job times out at 45
   minutes. Every run keeps its screenshots, named
   `<step>.<theme>.<viewport>.png`, as the `work-surfaces-walk` artifact for
   14 days, and a failed run keeps the server logs.

8. **Page-load gains the Work routes.** `e2e/routes.ts` adds the Work page's
   four tabs, Work setup's three, Outcomes, and one work item, `WI-1`, which
   `seed:e2e` now enters. The item page titles itself `WI-1 · Work item`, so
   `expectedTitle` puts the last path segment before the page name for that
   row. The row shape stays `{ path, titleKey }`.

## Consequences

- A change to the Work pages gets a real-browser check of every state, both
  themes, the keyboard, and a phone screen before it merges. The screenshots
  give a reviewer the pages without a dev server.
- The walk and the pages share a contract: the test ids and the status and
  wait codes in `states.ts`. A page that renames one breaks the walk, and the
  message names the page and what it showed.
- Accept that succeeds is never walked in a browser. It is proven in
  `dispatch.pg.test.ts` and the component tests. The Technical release gate
  still needs an authorized deployed workspace with a real GitHub connection,
  and this walk does not replace it.
- The walk adds one job that builds the app and seeds three stores on each
  ready pull request that touches Work. A draft does not pay for it.
- The walk does not run on a push to `main`. A dispatch walks `main` when
  someone needs the evidence for it.
- This decision does not make the walk a required check.

## Alternatives considered

- **A fourth e2e spec.** Rejected. INV-20 and §0.12 hold the suite at three
  files, and the e2e job runs on every pull request, so every change would pay
  for the Work walk. The parity capture already settled where a CI-only
  browser walk lives.
- **Vitest browser mode.** Rejected. It adds a dependency and a second
  browser runner, and it renders components, not the production build behind
  a real session. It cannot prove the server refusing `dana`, the real
  routes, or the records the store reduces. The workflow steps would still
  need a server.
- **A GitHub reader switch in production code.** Rejected. A setting that
  swaps `githubEvidenceReader` for a fake would let Accept succeed in CI, but
  INV-22 forbids a dev-only data switch in the production bundle, and an
  Accept that passes without reading GitHub is the fixture-derived production
  success the phase plan forbids. The success path is proven where a fake
  belongs, inside `dispatch.pg.test.ts`.
