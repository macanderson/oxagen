---
name: repl-session-memory-unmount-leak
type: bug
domain: cli
severity: P2
linear: OXA-CLI-STABILITY
date: 2026-06-28
---

**Symptom:** The interactive REPL leaked its session-memory handle (and the
backing DuckDB connection) when the process exited shortly after launch.

**Root cause:** `ReplApp`'s mount effect opens session memory asynchronously
(`void openSessionMemory(...).then(m => { mem = m; memoryRef.current = m })`).
If the component unmounts before that promise resolves, the effect's cleanup
runs while the local `mem` is still `null` and closes nothing — then the open
resolves afterwards and the handle is never closed.

**Fix:** add a `cancelled` flag in the effect; when the open resolves after
unmount, close the handle immediately instead of storing it. Added a `.catch`
so the best-effort open can never surface as an unhandled rejection.
(apps/cli/src/repl/interactive.tsx)

**Guard:** interactive.memory-lifecycle.test.tsx parks the async open, unmounts,
then resolves it and asserts `close()` is called (fails on the old code).

**Watch-outs:** any React effect that assigns an async-acquired resource to a
ref must guard the unmount-before-resolve race — the cleanup closure captures
the *local* at unmount time, not the value that lands later.
