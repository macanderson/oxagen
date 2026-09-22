# ADR-138: An external tool's identity is case-folded at the decision gate

Status: Accepted

Date: 2026-09-22

Related: #3137, #3055, ADR-122, ADR-025

## Context

One external MCP tool reaches Oxagen under two spellings of one name.

The materializer builds the identity a call is governed under from the name the
server returned, verbatim: `materializePinnedMcpTools`
(`packages/agent/src/dispatch/mcp-client.ts:195`) writes
`mcp.<serverId>.<tool>`, and `materializeMcpTools` writes
`file-mcp.<serverName>.<tool>` the same way. That string is what
`enforceExternalDecisionRules` hands the decision gate.

The tool registry derives its own identity for the same tool and folds its
case: `toolSlugOf` (`packages/handlers/src/lib/tool-registry.ts:89`) lower-cases
the name before it builds the slug, so `createIssue` and `CreateIssue` on one
server are one registry row. Every auto-approval rule pattern, every
`no_tool_matches` refusal and every `list_tools` slug reads that folded form.

`capabilityMatches` (`packages/rules/src/evaluate.ts`) compared byte for byte.
So a deny rule naming `mcp.<serverId>.createissue`, the form the registry holds,
saved cleanly, listed as enabled, and never matched the call
`mcp.<serverId>.createIssue`. This is the failure #3137 describes: a rule that
saves and appears active but covers nothing is worse than one that is refused,
because the operator stops checking. It is also the third instance of the same
root cause as #3055 and #3137, which is that an external tool's identity is a
third party's string and Oxagen has more than one rule for reading it.

## Decision

The decision gate folds the case of an external tool identity on both sides of
a rule match. `canonicalToolIdentity` lower-cases a name whose first segment is
`mcp` or `file-mcp` and returns every other name untouched;
`capabilityMatches` compares the folded pattern against the folded candidate,
so `evaluateRules`, `requiredFactKeys` and the gate's external fact collection
all read one identity.

A platform capability is unaffected. ADR-025 admits `[a-z][a-z0-9_]*` for a
registered name, and the rule schema's own non-external pattern is lower case,
so folding a built-in name is a no-op and the comparison for one stays exact.

Two alternatives were rejected.

Lower-casing the runtime identity itself was rejected. That string is also the
subject of IAM policies, kill switches, MCP consent rows, tool-invocation
telemetry and every run spec's `tool_policy.allowlist`. Changing it would
silently retire grants and switches an operator wrote against the current
spelling, on every workspace at once, to fix a matcher.

Leaving the comparison byte-exact and refusing the mismatched spelling at
authoring time was rejected. The gate cannot tell a mis-cased identity from a
tool that is simply not installed yet, and #3118's `rule_not_gated` refusal,
which tried that shape, was removed by ADR-122 for the same reason.

Auto-approval authoring keeps its exact comparison. A rule pattern there is
matched against the registry slug, which is already folded, so a pattern in the
server's spelling is refused as `no_tool_matches`, which names the pattern and
sends the call to a person. That is the safe direction and needs no change.

## Consequences

A deny or approval rule written in either spelling governs the call. Two
external tools on one server whose names differ only in case cannot be told
apart by a rule, which matches what the registry already does with them, since
it folds both into one row.

The registry lookup on the decision path keeps its exact comparison:
`loadDeclaredTool` (`packages/rules/src/call-facts.ts`) selects on
`tools.slug = <capability>` and therefore finds no row for an external identity
that carries a capital. That direction fails closed. The auto-approval floor
records `tool_not_declared` and no call is released, and an agent principal's
external call is already refused by ADR-122 before a mandate is reached. It is
recorded here rather than changed, because changing it would widen what an
external call can reach for no governance gain.
