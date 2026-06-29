---
name: cli-best-effort-catches-need-debug-breadcrumb
type: observation
domain: cli
severity: P3
linear: OXA-CLI-STABILITY
date: 2026-06-28
---

**Observation:** The CLI deliberately uses best-effort persistence (trace store,
verbose JSONL log, permission-broker settings read, session memory) where a
failed write must never break a turn. Several of these had fully empty `catch`
blocks, so a dropped trace / missing verbose record / discarded settings was
invisible even with debugging enabled — undiagnosable in the field.

**Pattern to follow:** keep these catches best-effort (never rethrow) but add a
tagged breadcrumb gated on `OXAGEN_DEBUG`, matching the house style already in
agent/memory.ts:

```ts
} catch (err) {
  if (process.env["OXAGEN_DEBUG"])
    process.stderr.write(`[trace-store] write failed (${path}): ${msg(err)}\n`);
}
```

This keeps stdout clean (it stays the pipeable answer in one-shot mode), adds no
noise by default, and makes silent data loss diagnosable. Touched
trace-store.ts, verbose-log.ts, permissions.ts (persistRule) in this pass.

**Also:** the agent's mutating tools are gated at **two** independent layers —
the `PermissionBroker` wrapper inside `buildTools` (interactive approval) and the
settings-driven `wrapToolsWithGate` at the loop level. Both must stay fail-closed.
The broker wrapper now denies when a mutating call can't be normalized into a
permission request (was fail-open). tools-gating.test.ts pins that all three of
write_file/edit_file/bash are broker-gated.
