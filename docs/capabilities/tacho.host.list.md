# list_tacho_hosts

List the machines enrolled as Tacho hosts in this workspace, newest first, with status, mode, the operating system version and CPU architecture the host reported at enrollment (`osVersion`, `arch`, null when it reported none), harness and version facts, liveness (last seen, last ingest, hooks and OpenTelemetry health, spool depth), and counters (sessions, unobserved sessions, open incidents). Cursor-paginated.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/tacho/hosts`
- MCP: `list_tacho_hosts`
- CLI: `oxagen tacho hosts [--status <state>] [--limit <n>] [--json]`
- App: Runtimes, at `/{orgSlug}/{workspaceSlug}/runtimes`, and one runtime at `/{orgSlug}/{workspaceSlug}/runtimes/{hostEnrollmentId}`
- Authentication: session (org Owner or Admin; workspace Owner, Member or Viewer)
- Capability name: `list_tacho_hosts`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `status` | enum | no | `active`, `paused`, `suspended`, `revoked` |
| `limit` | integer | no | 1-200, default 50 |
| `cursor` | string | no | from a previous `nextCursor` |

## Output

| Field | Type | Description |
|---|---|---|
| `hosts` | object[] | host summaries |
| `nextCursor` | string or null | |

Each host summary carries `harnesses` (the apps on that machine) and `tiers`
(what Oxagen records for each of them). The two say different things and both
are needed to describe a machine honestly — see below.

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.

`tiers` maps each of a host's harnesses to the enforcement tier it reaches
(ADR-078), using the same `enforcement_tier` vocabulary the session record
speaks:

| `tiers[harness]` | Product word | What it records | What it does not |
|---|---|---|---|
| `harness` | **wrapped** | every action the agent takes, including its own commands and file edits, hash-chained per session | Oxagen does not run the process, so the record is what the agent reported; removing the hook stops the reporting |
| `gateway` | **connected** | the Oxagen tool calls the app made, and the ones refused — refused *on the server*, so a deny is a refusal rather than an attestation | no prompts, no model calls, no session boundary, and nothing the app does through any other MCP server |

**Neither tier dominates the other.** Wrapped is broader and weaker; connected
is narrower and stronger. A surface that renders them on one axis — a coverage
meter, "fully" versus "partially" governed, a count that adds them together —
is wrong in both directions, and ADR-078 section 2 forbids it. One machine
normally carries both, which is why the tier is per harness rather than per
host.
