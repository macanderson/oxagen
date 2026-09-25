# resolve_mcp_consent

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Grant or deny first-use consent for an external MCP tool. The decision
resumes the paused agent stream and is remembered for subsequent calls so
the same tool no longer re-prompts. When `grantAllTools` is set on a
`granted` decision, every tool on the server is pre-granted.

A person makes this decision. The contract is not on the `agent` surface, so
no model is offered it as a tool (ADR-XXX). It answers only a consent request:
a row the first-use consent gate wrote with `kind = 'consent'`.

## Input

| Field           | Type                       | Notes                                                                          |
| --------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `approvalId`    | `string`                   | The pending consent request id (the underlying approval row id) to resolve.    |
| `decision`      | `"granted" \| "denied"`    | Grant or deny first-use consent.                                               |
| `grantAllTools` | `boolean?`                 | When true (and `decision=granted`), pre-grant every tool on the server (`*`).  |

## Output

| Field        | Type                                  | Notes                                  |
| ------------ | ------------------------------------- | -------------------------------------- |
| `approvalId` | `string`                              | The resolved consent request id.       |
| `resolution` | `"granted" \| "denied" \| "expired"`  | Final resolution of the consent.       |

## Roles

Org Owner or Admin, or workspace Owner or Member, the contract's
`defaultRoles`, checked by the handler (`assertOrgRole`) for the signed-in
user or the creator of the API key. That person is recorded as the resolver
and as the subject of the durable consent. A call that carries the run the
row records as raising the request is refused. Every refusal comes before the
row is touched.

## Side effects

- Postgres: upsert `agent.mcp_consents` grant row(s); resolve the backing approval row.
- ClickHouse: emit `agent.mcp.consent.resolved` event.
- Resumes the paused agent stream waiting on the consent gate.

## Errors

| code        | reason                            | meaning                                                                                                   |
| ----------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `forbidden` | `no_principal`                    | No signed-in user and no API key with a live creator (403).                                               |
| `forbidden` | `org_role_required`               | The acting user holds none of the roles above (403).                                                      |
| `conflict`  | `not_a_consent_request`           | The pending row is not a consent request, such as a parked write. Answer it with `resolve_approval` (409). |
| `forbidden` | `run_cannot_resolve_own_approval` | The call carries the run that raised the request (403).                                                   |

A row that is not pending (unknown, expired, already resolved, or in another
workspace) is not an error: the output reads `expired`.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
