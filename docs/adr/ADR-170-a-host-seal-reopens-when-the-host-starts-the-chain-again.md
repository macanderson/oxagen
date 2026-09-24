# ADR-170: A host's seal reopens when the host starts the chain again

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** platform
- **Amends:** ADR-159 §4 ("A host's seal is final").
- **Related:** ADR-058 (the seal grades a session), ADR-169 (an operator's
  seal is final), #4084 (the daemon reopens its record on a resume), issue
  #4091.

## Context

A wrapped session seals when its host sends `agent_stop`. The host sends one
from the harness's `SessionEnd` hook, or from the daemon's sweep once the
harness process is gone or a session has sat quiet past its window. ADR-159
made that seal final: later frames land on the chain as evidence and leave the
run's status alone.

Claude Code does not end a session for good when its process exits. `claude
--resume` starts the same session id again, and a background session exits
between messages and comes back in a new process for the next one. Both send
`SessionStart` with `source: resume`, and the daemon continues the chain at
its cursor. On 2026-09-24 the sweep sealed one such session as `crashed` at
17:52 UTC, the session resumed at 19:39, and its run read `sealed` for as long
as it kept working. Its cost read as final while it grew, and every command
was refused with `run_sealed`.

Since #4084 the daemon reopens its own record on `SessionStart`, and on any
hook for a session its sweep closed for quiet. The control plane had no rule
that followed it.

## Decision

1. **An `agent_start` after the stop reopens the run.** When a batch carries
   an `agent_start` on a chain whose row the host sealed (`seal_source =
   'agent_stop'`, or null on a row sealed before the column existed), ingest
   clears what the seal wrote: `sealed_at`, `seal_source`, `ended_at`,
   `final_hash`, `unobserved_tail`, `completeness_gaps`, `replay_grade`,
   `end_reason` and `terminal_reason`, with `outcome` back to `running`. The
   run is rolled up as an estimate again. The update is conditional on the
   seal it read, as the idle reopen is.
2. **Nothing else reopens it.** A transcript line, an OTel record, a subagent's
   frame or a checkpoint after the stop is still evidence about a session that
   ended, and leaves the seal in place. Only the host seals an `agent_start` on
   a chain that has already begun.
3. **The daemon says when it reopens.** A resume's `SessionStart` hook seals
   its own `agent_start`. When any other hook reopens a session the sweep
   closed for quiet, the daemon seals an `agent_start` with
   `session_start_source: reopen` ahead of that hook's frames.
4. **The next stop seals the run again.** A later `agent_stop` writes a new
   seal and grade over the reopened row and sends `cost/run.sealed`. A batch
   that holds the resume and the next stop seals it once. A batch that holds a
   stop and then a restart leaves the run open.
5. **An operator's seal stays final** (ADR-169). A person decided the run is
   over, and a resume does not overturn that.

## Consequences

- One Claude Code session is one run, however many times it resumes.
- A run can seal more than once. `sealed_at`, `final_hash` and `replay_grade`
  describe the latest seal. An export signed before a resume attests the chain
  to that seal's head. The chain is append-only, so that bundle still verifies
  as a prefix, and a new export covers the frames after it.
- The findings pass and the final rollup run again at each seal.
- A resumed run shows its controls again, and a command reaches the resumed
  harness on its host's next poll.

## Alternatives rejected

- **A new run linked to the sealed one.** The session keeps its id, its
  transcript and its chain, so a second run would split one piece of work
  across two pages with one hash chain between them. Nothing in the evidence
  model needs the split: the chain never breaks, and the seal is a row fact
  the next seal replaces.
- **Reopen only a seal the sweep inferred.** The sweep also seals a session
  as `completed` when the process exits after its last turn, which is how a
  background session ends every message, and a clean `SessionEnd` followed by
  `claude --resume` is the same session again. Both would stay sealed.
- **Reopen on any frame after the stop.** The transcript tailer and OTel
  deliver frames after a real end, so every finished run would reopen.
