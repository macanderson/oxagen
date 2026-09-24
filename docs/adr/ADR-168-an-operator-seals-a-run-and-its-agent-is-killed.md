# ADR-168: An operator seals a run, and its agent is killed

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** platform
- **Amends:** ADR-159 (the control plane was the one seal writer besides the
  host, and only for silence).
- **Related:** ADR-056 (run controls travel on the host's command poll),
  ADR-058 (the seal grades a session), ADR-163 (controls do not depend on the
  policy tier), issue #4073.

## Context

A wrapped session seals in two ways. Its host sends `agent_stop`, from the
harness's `SessionEnd` hook or from the daemon's sweep once the harness process
is gone. Or the control plane closes it after twelve hours with no event
(`idle_timeout`, ADR-159), and that close stays open to correction.

An operator often knows sooner than either. The agent answered, the terminal
sits open, and the run reads live on Fleet and the Run page for up to twelve
hours. Its cost stays an estimate and its wall clock keeps counting. The
harness can also be hung rather than finished, still holding a process and
its credentials.

Cancel (`dispatch_command`) does not settle it. The host sends SIGTERM to the
agent's pid and denies every later tool call, but the run stays open until
the host's sweep sees the process gone, and a host that is offline never
collects the command at all. Codex and Cursor sessions give the host no pid,
so cancel only denies their next tool call. An idle-closed run showed no
controls, because the page read it as sealed.

## Decision

1. **A new capability, `seal_run`.** It takes a run id and an optional reason.
   An org Owner or Admin, or the workspace's Owner, may call it. It is not
   offered to a workspace Member, who can still cancel: cancelling stops the
   agent, and sealing also closes the record. The in-app agent's toolbelt holds
   the call for a person's approval (`agent.requiresApproval`). A call over
   the API or MCP runs with the key's creator's roles, so it is that person's
   own call.

2. **It seals the run now.** The root session and every chain of its run that
   is open or idle-closed seal in one transaction, with the columns the idle
   close writes: outcome `unknown`, the end at the last event received, the
   head the control plane holds as the final hash, and an unobserved tail,
   which grades the recording `inspect`. Only the source differs:
   `seal_source = 'operator'`. The outcome stays `unknown` because the
   operator's word is that the run is over, not how it ended. The run's cost
   is rolled up final (`cost/run.sealed`).

3. **The seal is final.** A later frame does not reopen an operator seal, and
   a later `agent_stop` does not replace it. Ingest already treats every seal
   but `idle_timeout` this way, so the host's frames still land on the chain
   as evidence without changing the run's status. A person decided, so the
   control plane does not overturn the decision on the strength of a frame.

4. **It kills the agent where it can.** When the run's host can collect a
   command (`commandBlockOf` answers null), the same transaction queues
   `kill`. The host already handles it: it sends SIGKILL to the agent's pid
   and denies every later tool call. When the host cannot collect one (it is
   offline, revoked, or the run names no host), the seal still goes ahead,
   and the answer says the kill was not sent and why. A finished agent on an
   unreachable host has nothing left to stop, and a hung one is stopped by
   the deny once its host comes back.

5. **A ledger run is refused.** Its producer seals it, and `dispatch_command`
   cancel already fences its ingress and revokes its run credentials.

6. **Schema.** `tacho.sessions.seal_source` admits `operator`. The check is
   replaced `NOT VALID`, as the one it widens was, because every existing row
   already satisfies it.

## Consequences

- The Run page offers Seal run on a live wrapped run and on an idle-closed
  one, and its header says the run was sealed by an operator.
- `list_runs` and `get_run` can answer `sealSource: operator`. A client that
  switched over the two earlier values must read the third.
- A run an operator sealed exports like any other sealed run. The bundle
  carries the unobserved tail and the `inspect` grade the seal recorded.
- Frames the host sends after the seal extend the chain past the final hash
  the seal recorded. The Chain tab reads them as it reads frames after a host
  seal.

## Alternatives rejected

- **Let a later `agent_stop` replace the operator's seal**, as it replaces the
  idle close. That would move a run a person closed back to the host's
  version of events whenever a killed harness's sweep reported, and the
  record would no longer say a person sealed it.
- **Seal only after the host acknowledges the kill.** The runs this exists for
  are the ones whose host cannot answer.
- **Add `kill` to `dispatch_command`.** Killing without sealing leaves the run
  open until the host's sweep, which is the state this decision removes, and
  sealing is a different permission from stopping.
- **Record the outcome as `cancelled`.** The operator seals runs that finished
  as well as runs that hung, so the record would claim a cancellation that
  did not happen.
