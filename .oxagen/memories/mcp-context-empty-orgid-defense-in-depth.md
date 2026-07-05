---
name: mcp-context-empty-orgid-defense-in-depth
type: bug
domain: mcp
severity: P2
linear: OXA-2056
date: 2026-07-04
---

**Symptom:** Ticket OXA-2056 described `apps/mcp/src/context.ts` as accepting `orgId: ''` from the session-token auth path as a valid scope. By the time this ticket was picked up, the session-token path already unconditionally rejected any bearer token without an underscore (`invalid_token`, from an earlier fix under OXA-1515) — so that specific path was already closed. However, the API-key resolution branch (`resolveApiKey()` → `resolution.orgId`/`workspaceId`) had no explicit guard against an empty string, and would have flowed through to a "success" `api_key.used` security-event emit and a `CapabilityContext` with `orgId: ""` before the kernel's `runInTenantScope` uuid guard eventually caught it deeper in the stack.

**Root cause:** No defense-in-depth check at the MCP auth edge for a resolved-but-empty org/workspace scope; the only protection was a downstream kernel guard several layers away, which produces a confusing error and lets a "success" audit event get emitted for a request that isn't actually valid.

**Fix:** Added an explicit check in `resolveMcpContext()` (`apps/mcp/src/context.ts`) — after a successful `resolveApiKey()` resolution, if `resolution.orgId` or `resolution.workspaceId` is empty/falsy, return `{ ok: false, reason: "invalid_token" }` before emitting the `api_key.used` security event or constructing the context.

**Guard:** `apps/mcp/src/context.test.ts` — new tests: "rejects a resolved API key with an empty orgId", "rejects a resolved API key with an empty workspaceId", "does NOT emit api_key.used when the resolved orgId is empty", and a `buildContext` test asserting `McpUnauthorizedError` with `reason: "invalid_token"`.

**Watch-outs:** This is genuinely defense-in-depth — `resolveApiKey()` should never return `ok: true` with an empty orgId today (the DB column is populated at key creation), so this path is not currently reachable via a real API key. It exists to guard against future data-integrity bugs / bad migrations / refactors of `resolveApiKey()`, and to keep the same "reject empty scope at the edge" invariant symmetric across both the session-token and API-key auth paths.
