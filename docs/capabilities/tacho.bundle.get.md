# tacho.bundle.get

The signed policy bundle a host caches and evaluates locally (`docs/specs/tacho/spec.md` section 7.1). The bundle is signed with Ed25519 over its RFC 8785 canonical form; the host verifies it offline with the public key it received at enrollment and refuses one it cannot verify, so enforcement fails closed with the daemon and the network down. Send the cached `etag` to receive `not_modified` without a body.

In this phase the bundle is observe-mode with empty rule lists: status, deny generations, etag, and signing are live; the IAM compiler that fills `permissions` and `tools` lands with the authority phase.

## Mode

**sync**

## Surface

- API only: `POST /v1/tacho/bundle`
- Authentication: enrolled host API key only
- Capability name: `get_tacho_bundle`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `host_enrollment_id` | string | yes | must equal the key's scope |
| `etag` | string | no | the cached bundle's etag |

## Output

| Field | Type | Description |
|---|---|---|
| `not_modified` | boolean | true when `etag` matched |
| `etag` | string | the current etag |
| `bundle` | object or null | present exactly when `not_modified` is false |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
