# get_run_proof

The Run page's Proof tab (Mission Control spec §8.5; ADR-064): every witness that reported on one run, each with its attempts as the `proof.observed` frames recorded them, the run's verdict, the cost of each witness run, and the workspace's disclosure grain.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/proof`
- MCP: none. MCP is the surface agents connect to, and a worker must not learn which witness failed or which were held out (§8.5 invariants 2 and 3).
- Authentication: a signed-in session only (org Owner, Admin or Member; workspace Owner or Member). Every API-key caller is refused with `forbidden` (`session_required`), whoever minted the key.
- App: the Proof tab at `/{org}/{workspace}/runs/{run}?tab=proof`. It shows recorded verdicts and runner attestations; it does not independently verify the signature. Witness-run links open their run records. Missing verdicts and costs remain unrecorded.
- Capability name: `get_run_proof`
- Not billed (`noBillingGate: true`): a console read is never a governed action. IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `verdict` | enum or null | `flipped`, `failing`, `unmoved`, `unsatisfied`, `tampered`, `unverified`, `waived`; each witness holds its latest attempt's verdict and the run takes the highest-ranked word in that order: `tampered`, `failing`, `unsatisfied`, `unverified`, `unmoved`, `flipped`, `waived`. Null when no witness reported. Only `flipped` marks the run proven |
| `witnesses` | object[] | `{ witnessId, oracle, commandDigest, heldOut, verdict, attempts }`, in the order their first frame arrived |
| `witnesses[].oracle` | enum | `test_flip`, `build_or_type`, `property`, `golden_snapshot`, `contract`, `metamorphic`, `behavioral_probe` |
| `witnesses[].heldOut` | boolean | reported to the record, never to the worker |
| `witnesses[].attempts` | object[] | one per `proof.observed` frame, in frame order: `{ attemptNo, frameSeq, observedAt, targetRef, targetSha, prRef, prSha, targetResult, prResult, verdict, failFingerprint, passOutputDigest, tamperExclusion, tamper, disclosureGrain, witnessRunId, runnerAttestation }` |
| `…attempts[].targetResult`, `prResult` | enum | `pass`, `fail`, `excluded` (a head result the tamper exclusion threw out), `inconclusive` |
| `…attempts[].tamper` | object or null | `{ fingerprintAuthored, fingerprintAtRun }` exactly when `tamperExclusion` is `broken` |
| `…attempts[].runnerAttestation` | object | `{ keyId, signature }`: the runner's signed statement, sealed with the frame |
| `witnessRuns` | object[] | `{ runId, cost }`, one per distinct witness run; `cost` is the run's `cost.run_totals` figure with its basis, null until the rollup priced it |
| `disclosureGrain` | enum | the workspace's grain now: `L0` unless an Owner or Admin raised it with `set_disclosure_grain` |

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | `session_required` | an API-key caller, or no signed-in user |
| `forbidden` | `org_role_required` | a user outside the org's members |

## Honesty

A run no witness reported on answers `verdict: null` and an empty list; nothing reads a verdict from a model. Only digests travel: the record holds no command text, test name or witness path, so none can be returned. An ingested verdict is as attested as the chain it arrived on (§8.3). Every read names `org_id` and `workspace_id` beside RLS, so another workspace's run answers the empty record.
