---
name: structured-tool-io-error-misclassification
type: bug
domain: cli
severity: P2
linear: OXA-CLI-STABILITY
date: 2026-06-28
---

**Symptom:** `structureToolResult` reported successful tool results as failures
(and vice-versa) for certain shapes.

**Root cause:** lib/structured-tool-io.ts had its own `isErrorResult` using
`typeof result === "object" && "error" in result`. That flags a _successful_
`{ error: null }` or `{ error: false }` as an error (the key is present) and
misses the `{ isError: true }` convention entirely. It had diverged from the
canonical heuristic in agent/loop.ts.

**Fix:** align the local heuristic with loop.ts — Error instance, `isError ===
true`, or a _present-and-truthy_ `error` field. Added a zod schema
(`structuredToolResultSchema`) + `parseStructuredToolResult` so a record that
crossed a trust boundary (IPC/daemon/disk) is validated, not cast blindly.
(apps/cli/src/lib/structured-tool-io.ts)

**Guard:** structured-tool-io.test.ts pins `{ error: null }`, `{ error: false }`,
`{ isError: true }`, Error instances, and schema validation.

**Watch-outs:** "error detection" logic is duplicated in at least two CLI spots
(agent/loop.ts `isErrorResult` is the canonical one). `"x" in obj` is a presence
test, not a truthiness test — never use it to decide error vs success.
