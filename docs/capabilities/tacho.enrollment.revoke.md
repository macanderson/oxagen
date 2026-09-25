# revoke_tacho_enrollment

Revoke a Tacho host. The host's API keys are soft-deleted, the host row becomes `revoked`, and a `revoke` command is queued. Idempotent.

A retired key cannot fetch that command, so the host learns of the revocation from the refusal. Its next ingest or command poll is answered 403 with the reason `host_revoked`, for a retired key by the API's auth resolver and for a live key on a revoked host by the handler (#3944). The collector then marks the host revoked, stops shipping, polling, and refreshing its bundle, keeps its recorded events in the local spool, and shows the revocation in `tacho status`. From then on every session on the host is denied at its next prompt or tool boundary while the hooks remain installed. If they are not installed, the next session on the host is an `unobserved_session` incident.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/tacho/enrollments/revoke`
- App: Agents › one agent › Enrollment — Revoke on a host row, confirmed by hostname, with the optional reason (`apps/app/src/features/agents/enrollment-controls.tsx`). `app` is a layer, not a `CapabilitySurface`: the app reaches the kernel through its own seam, which passes surface `app` and never consults the allowlist above
- Authentication: org Owner or Admin, by session or by the API key `oxagen login` minted for them (what `tacho unenroll` sends); a key bound to an enrolled machine is refused (ADR-079)
- Capability name: `revoke_tacho_enrollment`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `hostEnrollmentId` | string | yes | `tch_` public id |
| `reason` | string | no | up to 512 chars, recorded on the row and in the command |

## Output

| Field | Type | Description |
|---|---|---|
| `hostEnrollmentId` | string | |
| `status` | `revoked` | |
| `revokedAt` | string | RFC 3339 |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
