# Fleet capacity rig review

Reviewed the fleet generator, store reconciler, regression tests, manual workflow,
script TypeScript scope, and nine operator environment registrations for #4202.
This is a static review. CI must establish type, lint, and test results. Local
execution remains prohibited. The parent agent owns publication.

| Severity | Location | Issue | Status |
| --- | --- | --- | --- |
| P1 | `tools/scripts/fleet-capacity/run.ts:219` | Control probes counted empty or invalid signed policy responses as success. | Fixed |

The probe sent no etag but accepted a not-modified response with no policy. It
also accepted a schema-valid bundle without verifying its signature or host.
That could record `intakePass` despite an unusable control response. Probes now
require a full policy, matching response and policy etags, and a signature from
the pinned key for the requested host. Regression coverage includes empty
responses, wrong etags, wrong hosts, wrong signing keys, forged signatures, and
a full generator run that must fail intake acceptance on an invalid response.

The generator limits hosts, active requests, queued bytes, response bytes,
request count, network bytes, phase duration, enrollment duration, and retained
samples. Missed arrivals remain counted. Request deadlines include body reads.
Credentials remain in private files and are excluded from uploaded reports.
The workflow defaults to planning and gates live load on main, staging
credentials, and a dedicated runner. Store queries use pinned staging hosts,
tenant predicates, run-specific identities, time limits, and bounded results.

No other blocking defect was found in this scope. The report deliberately keeps
`capacityPass` false. Provider admission, exact stored-body integrity, monetary
idempotence, dependency faults, tenant isolation, service memory, long histories,
and background completion still require independent evidence. This review does
not approve a capacity claim or infrastructure spending. The offline baseline
collector is a separate concurrent change and was not included in this review.

No PR was opened by this agent. Publication and CI evidence remain pending.
