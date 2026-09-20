# revoke_tacho_enrollment

Revoke a Tacho host. The host's API key is soft-deleted, the host row becomes `revoked`, and a `revoke` command is queued so a collector mid-poll learns immediately rather than at its next bundle refresh. Every session on the host is denied at its next prompt or tool boundary while the hooks remain installed; if they do not, the next session on the host is an `unobserved_session` incident. Idempotent.

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
