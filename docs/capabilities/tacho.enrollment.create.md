# create_tacho_enrollment

Enrol a machine as a Tacho host (`docs/specs/tacho/spec.md` section 5.2). This is the operator half of the host trust boundary: `ingest_tacho_events`, `get_tacho_bundle`, and `fetch_commands` refuse any API key that does not carry the server-owned `tacho_host_v1` scope, and the generic `create_api_key` and `rotate_api_key` capabilities refuse to mint or preserve that scope. This capability is its only writer.

The response carries, once each and never again: the host's API key, the HMAC-signed enrollment document the collector verifies offline against the secret named by `verification_secret_env`, the initial Ed25519-signed policy bundle, and the bundle-signing public key. The host's `agentKey` is derived from the organization and workspace namespaces (ADR-024) and the hostname, so it is the identifier a bill, an audit row, and a fleet page show.

Refuses when the deployment holds no enrollment signing secret or no bundle signing key ([`TACHO_ENROLLMENT_SIGNING_SECRET`](../../packages/config/src/registry.ts), [`TACHO_BUNDLE_SIGNING_PRIVATE_KEY`](../../packages/config/src/registry.ts)), which is a deployment defect, not a caller decision. It signs only the deployment's own Tacho endpoints ([`TACHO_INGEST_ENDPOINTS`](../../packages/config/src/registry.ts)), so an operator cannot aim a fleet of hosts at a third party.

## The agent file

Once the host is enrolled, Oxagen opens a steering PR that adds `agents/<runtime>.toml`, the agent/v1 file the MCP gateway matches the host's runs to before it serves them any published tool ([ADR-266](../adr/ADR-266-enrollment-proposes-the-runtimes-agent-file.md), #5149). The file names the member who enrolled the host as its operator, by public user id, the runtime the hostname binds, and the first harness the host reports that an agent file can name. It carries no secret, and no `toolbelt`, `budget`, or `environment`.

The PR carries an `agent_file` proposal ([ADR-265](../adr/ADR-265-every-steering-pr-oxagen-opens-carries-a-proposal-row.md)), so a person merges it from Oxagen with [`merge_steering_pr`](steering.pr.merge.md). Oxagen opens no PR when:

- an agent file proposal for the runtime is open or merged, so enrolling the same runtime again opens no second PR
- the production branch already holds `agents/<runtime>.toml`, or another agent file names the runtime
- the runtime's slug is not a valid agent name, or the host reports only Claude Desktop
- the workspace has no steering repository

The enrollment's answer does not change either way. A PR that fails to open is logged, and the host stays enrolled. Enrollment waits up to 20 seconds for the PR. Past that it answers, and the PR keeps opening.

## Mode

**sync**

## Surface

- API only: `POST /v1/:org_slug/:workspace_slug/tacho/enrollments`
- Authentication: org Owner or Admin, by session or by the API key `oxagen login` minted for them (what `tacho enroll` and the desktop app send); a key bound to an enrolled machine is refused (ADR-079)
- Capability name: `create_tacho_enrollment`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `hostname` | string | yes | 1-253 chars |
| `osUser` | string | yes | 1-128 chars |
| `platform` | enum | yes | `darwin`, `linux`, `win32` |
| `devicePublicKey` | string | yes | `ed25519:<base64>` |
| `harnesses` | enum[] | yes | 1 or more of `claude-code`, `codex`, `cursor`, `stella`, `claude-desktop` |
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
