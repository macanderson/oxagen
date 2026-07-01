---
name: github-ingestion-deliveryconfig-not-populated
type: bug
domain: connectors
severity: P1
linear: OXA-1806
date: 2026-06-22
---

**Symptom:** GitHub repo ingestion fires the `ingestion/github.initial-sync` Inngest function with `owner=""` and `repo=""`, causing the GitHub tree API to 404 (`/repos///git/trees/main`), burning all 3 retries, and writing 0 nodes/edges to the graph.

**Root cause:** The GitHub connect wizard (Step3) sends `installationId`, `selectedRepos`, and `syncDepthDays` in the `PUT /connections/:id/mappings` body, but the `connection.mappings.set` contract input did NOT declare those fields, and also did not declare `owner`, `repo`, or `defaultBranch`. Zod's `.parse()` in `connection.ts` silently stripped all undeclared fields — the handler never received them. The handler then read `deliveryConfig` from the stored row (which was still `null` from the initial connection creation) and fell back to empty-string values for `owner` and `repo`.

The unit test `connection.mappings.set.test.ts` masked the bug: `GITHUB_CONN_ROW` had `deliveryConfig: { owner: "acme", repo: "my-api" }` pre-populated — it never tested the path where deliveryConfig is null and the fields arrive via request body.

**Fix (four parts):**

1. Extended `packages/oxagen/src/contracts/connection.mappings.set.ts` input schema to accept optional `installationId`, `selectedRepos`, `syncDepthDays`, `owner`, `repo`, `defaultBranch`.
2. Updated `packages/handlers/src/connection.mappings.set.ts` to merge the request-supplied fields into `source_connections.deliveryConfig` in the same `withTenantDb` transaction as the activation status flip, then build the Inngest event payload from the merged config.
3. Updated the wizard chain: Step2 (`github-connection-wizard-step2.tsx`) now passes `SelectedRepoMeta[]` (including `defaultBranch`) via `onNext`; Step3 (`github-connection-wizard-step3.tsx`) splits `selectedRepos[0]` into `owner`/`repo` and includes `owner`, `repo`, `defaultBranch` in the PUT body.
4. Added `NonRetriableError` guard in `ingestion.github-initial-sync.ts` — if `owner` or `repo` is empty, throws immediately instead of making the doomed fetch.

**Guard:**

- `connection.mappings.set.test.ts`: added tests proving deliveryConfig-merge from request input and that the event payload uses request values (not a pre-populated row). Old "sends empty owner/repo when deliveryConfig is null" test replaced with "uses request-supplied owner/repo when deliveryConfig is null (OXA-1806 root cause)".
- `ingestion.github-initial-sync.test.ts`: added two tests asserting `NonRetriableError` is thrown when `owner` or `repo` is empty, and that no GitHub fetch is attempted.
- `github-connection-wizard-step2.test.tsx`: added test asserting `onNext` is called with `SelectedRepoMeta[]` including `defaultBranch`.

**Watch-outs:**

- Any new wizard that calls `connection.mappings.set` must ensure the contract input includes all delivery config fields needed by the ingestion handler. Zod strips undeclared fields silently.
- The unit test `GITHUB_CONN_ROW` fixture should not have a pre-populated `deliveryConfig` for paths testing that the wizard supplies the values — it masked this bug for the duration.
- The current design only triggers one initial-sync per wizard activation (for `selectedRepos[0]`). Multi-repo fan-out is deferred; see OXA-1806 for tracking.
