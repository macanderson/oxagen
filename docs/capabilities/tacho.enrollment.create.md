# tacho.enrollment.create

Enrol a machine as a Tacho host (`docs/specs/tacho/spec.md` section 5.2). This is the operator half of the host trust boundary: `ingest_tacho_events`, `get_tacho_bundle`, and `fetch_tacho_commands` refuse any API key that does not carry the server-owned `tacho_host_v1` scope, and the generic `create_api_key` and `rotate_api_key` capabilities refuse to mint or preserve that scope. This capability is its only writer.

The response carries, once each and never again: the host's API key, the HMAC-signed enrollment document the collector verifies offline against the secret named by `verification_secret_env`, the initial Ed25519-signed policy bundle, and the bundle-signing public key. The host's `agentKey` is derived from the organization and workspace namespaces (ADR-024) and the hostname, so it is the identifier a bill, an audit row, and a fleet page show.

Refuses when `TACHO_ENROLLMENT_SIGNING_SECRET` or `TACHO_BUNDLE_SIGNING_PRIVATE_KEY` is unset (a deployment defect, not a caller decision), and signs only endpoints listed in `TACHO_INGEST_ENDPOINTS`, so an operator cannot aim a fleet of hosts at a third party.

## Mode

**sync**

## Surface

- API only: `POST /v1/:org_slug/:workspace_slug/tacho/enrollments`
- Authentication: session (org Owner or Admin)
- Capability name: `create_tacho_enrollment`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `hostname` | string | yes | 1-253 chars |
| `osUser` | string | yes | 1-128 chars |
| `platform` | enum | yes | `darwin`, `linux`, `win32` |
| `devicePublicKey` | string | yes | `ed25519:<base64>` |
| `harnesses` | enum[] | yes | `claude-code` |
| `claudeVersion`, `claudeExecpath`, `nodeVersion`, `wrapperVersion`, `shell`, `osVersion`, `arch` | string | no | host facts recorded on the row |
| `managed` | boolean | no | default `false`; managed-settings enrollment |
| `validityDays` | integer | no | 1-365, default 180 |

## Output

| Field | Type | Description |
|---|---|---|
| `hostEnrollmentId` | string | `tch_` public id |
| `agentKey` | string | ADR-024 key, e.g. `acme.core.cc-laptop` |
| `apiKeyPublicId`, `apiKey` | string | the host key; `apiKey` shown once |
| `enrollment` | object | `claims`, `signature_hex`, `verification_secret_env` |
| `policyBundle` | object | the initial signed bundle (`get_tacho_bundle` shape) |
| `bundlePublicKeyPem` | string | Ed25519 SPKI PEM the host verifies bundles with |
| `expiresAt` | string | RFC 3339 |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
