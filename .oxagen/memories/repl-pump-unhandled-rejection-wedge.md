---
name: repl-pump-unhandled-rejection-wedge
type: bug
domain: cli
severity: P1
linear: OXA-CLI-STABILITY
date: 2026-06-28
---

**Symptom:** A single failing turn in the interactive REPL could (a) abandon
every prompt already queued behind it and (b) escape as an unhandled rejection
from the `void pump()` call site. Separately, a throw from project
initialization left the thinking indicator stuck on forever.

**Root cause:** The prompt-queue pump awaited `handleSubmit` inside its drain
loop with no per-turn try/catch — a rejection broke the `while` loop, so the
remaining `queueRef` items were never drained, and the rejected pump promise
had no handler. `handleSubmit` also ran `initializeProject` _before_ its own
try/finally, so a throw there skipped the streaming-state reset.

**Fix:** wrap each `await handleSubmitRef.current(next)` in a try/catch that
surfaces the error via `pushAssistant` and keeps draining; move the project-init
block inside `handleSubmit`'s try so the finally always restores streaming
state. (apps/cli/src/repl/interactive.tsx)

**Guard:** interactive.pump-resilience.test.tsx queues a failing slash command
ahead of a real prompt and asserts the real prompt still runs.

**Watch-outs:** any fire-and-forget async driver (`void pump()`) must contain
per-iteration rejections, or one bad item kills the whole consumer. Keep all
setup that can throw inside the try whose finally restores UI/streaming state.
