---
name: tacho-steer-and-resume-never-reached-autonomous-agent
type: bug
domain: tacho
severity: P1
issue: "#4019"
date: 2026-09-23
---

**Symptom:** A steer sent to a Claude Code agent working on its own waited until a person typed the next prompt. A resumed agent stayed idle. An interrupt steer ended the turn and was never delivered. A subagent's PreToolUse decision sat on the parent chain while its tool request sat on the subagent chain.

**Root cause:** The hook handler drained operator messages only at SessionStart and UserPromptSubmit. PostToolUse and Stop fell to the record-only default branch. Resume cleared the pause flag and nothing more. The model proxy answered an interrupt steer's cut with a non-retryable 403, so Claude Code went to StopFailure, whose answer it ignores. `sealCollectorEvent` always seals on the root chain.

**Fix:** `packages/tacho/src/collector/hook-handler.ts` drains steers at PostToolUse and PostToolUseFailure (`additionalContext`) and at Stop (`decision: "block"`). An interrupt steer refuses the next main-agent tool call with the steer as the reason. The proxy cuts that model call as a retryable 503. Resume owes a continuation only when the pause refused a call (`SessionControl.pauseEffect`, `resumeOwed`). `SessionRecorder.sealCollectorEventOn` seals a subagent's decision on its own chain.

**Guard:** `packages/tacho/src/collector/run-controls.test.ts`.

**Watch-outs:** A hook answer cannot wake an idle Claude Code session; only an `asyncRewake` hook can, and the settings writer does not install one. Never drain at a subagent boundary or on a spool replay: the text reaches no one and the steer would be acked as applied. Stella can carry text only at SessionStart.
