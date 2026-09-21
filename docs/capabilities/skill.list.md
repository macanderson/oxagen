# list_skills

The skills this workspace's harness sessions reported when they started, over a window of session start times (#3098). The record is `tacho.sessions.skills_available`, the name list a wrapped harness reports at session start and `ingest_tacho_events` writes. Oxagen does not run, resolve or author a skill ([ADR-043](../adr/ADR-043-runtime-excision.md)): this read says which skills the harness had. The record holds names only, so no version, digest, source, token cost or decision is returned.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/skills`
- MCP: `list_skills`
- Authentication: session or API key (org Owner, Admin or Member; workspace Owner or Member). An API key acts as its creator, bounded by the creator's current role; a key with no recorded creator is refused `no_principal`.
- Capability name: `list_skills`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `windowDays` | integer | no | 1 to 90, default 30: sessions started in the last N days |
| `cursor` | string | no | the previous page's `nextCursor`; it carries that page's window, so `windowDays` is ignored beside it. A cursor this capability did not write, or one whose window is longer than the 90 days `windowDays` allows, is `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `window` | object | `{ from, to }`, RFC 3339: sessions started at or after `from` and before `to` |
| `sessions` | integer | sessions started in the window |
| `reportedSessions` | integer or null | sessions in the window that reported an inventory; null when none did |
| `notReportedSessions` | integer | sessions in the window whose inventory is null |
| `skills` | object[] | `{ name, sessions, harnesses, harnessCount, firstSeenAt, lastSeenAt }` per reported name, by name, at most 100 a page |
| `nextCursor` | string or null | the next page, or null on the last |

A session whose `skills_available` is null (or anything but a JSON array) did not report an inventory and counts toward `notReportedSessions`, never as a session with no skills. A session that reported an empty array counts toward `reportedSessions` and names no skill. A name an inventory lists twice counts that session once.

A skill row's `harnesses` round-trips exactly what its sessions reported, byte-for-byte, including an empty string when a session reported none — this read never invents a value or fails over one session's harness label ([ADR-104](../adr/ADR-104-a-harness-label-round-trips-whatever-it-holds.md)). The list is capped at 20 distinct harnesses; `harnessCount` carries the true distinct count past that cap.

## Errors

| Code | When |
|---|---|
| `forbidden` (`org_role_required`, `no_principal`) | the acting user holds none of the roles above, or an API key has no creator |
| `invalid_input` (`invalid_cursor`) | the cursor was not written by this capability, or its window is longer than the 90 days `windowDays` allows |

Counts and the current page of names come from one Postgres statement and share its snapshot. The response shape is unchanged. The Skills section shows `+N more` when the harness count exceeds the returned harness names.
