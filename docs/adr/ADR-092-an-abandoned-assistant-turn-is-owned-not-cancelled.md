# ADR-092: An abandoned assistant turn is owned to completion, not cancelled

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** app, agent
- **Related:** ADR-043 (Oxagen governs agents, and does not run them), ADR-053
  (the in-app agent's turn and its governed tool calls), #2953 (run controls:
  cancel on every run), #3230 (the finding this settles), #3216 (the flyout
  this changes)

## Context

The assistant flyout asks the in-app agent a question through
`ask_assistant`, invoked from a Server Action. The flyout lives in the
organization layout, so it survives a workspace switch, but a conversation
belongs to one workspace: the turn handler matches it on
`(id, orgId, workspaceId)`.

Until this decision, leaving a workspace mid-turn cleared the flyout's
transcript and conversation id, and a generation counter discarded the turn's
reply when it came back. The turn itself kept running. #3230 recorded what that
left behind:

- The model kept completing and the tools kept running, so the budget was spent
  on an answer nobody would see.
- Leaving cleared `pending`, so a person who came back could ask again while the
  first turn was still running, and the two then raced for one conversation id.
- A turn that parked governed writes delivered its parked notice to nobody, so
  the approvals waited on a person who was never told.
- The generation counter had to be written during render, under an
  `eslint-disable`, because writing it from an effect left a gap a reply could
  land in. Correctness depended on winning a race.

The issue offered two resolutions: stop the backend work when the person
leaves, or own the turn to completion and surface what it produced where the
person can act on it.

## Decision

**A turn the person walks away from is owned to completion.** The flyout keeps
one thread per workspace: transcript, conversation id, half-typed draft, and
in-flight flag. A turn fixes its thread when it is submitted and writes
everything it produces there: its reply, its run, its conversation id, a
refusal, any parked writes, and the end of `pending`. That holds whatever the
person is looking at when the action resolves.

**Stopping a turn on purpose is a separate thing, and it belongs to run
controls (#2953).** An assistant turn is recorded as a run (`arun_…`), so an
explicit Stop should go through the cancel #2953 builds for every run, not
through a mechanism specific to the flyout. #2953 is open and that cancel
does not exist yet: today, nothing stops a turn once it is asked.

## Why not cancel on navigation

Cancellation was the obvious reading of #3230, and it is the wrong default for
four reasons.

**A question asked is work the person wanted.** The turn is a governed, metered
run. Throwing its answer away because someone clicked into another workspace
discards work they asked for and have already paid for. People leave a chat to
check something and come back for the answer. They do not expect navigation to
retract the question.

**Cancelling mid-turn is the riskier failure.** A turn answers tool calls, and
some of those are governed writes. Stopping it partway can leave an action half
done. Running to completion cannot, and the one hazard completion carries, a
parked write going unseen, is the one this decision fixes directly.

**Run cancellation already has an owner.** #2953 is the lane for cancel on
every run. An assistant-only cancel would be a second, narrower mechanism that
#2953 would then have to absorb or reconcile. Cancelling across nodes also needs a durable record
that the process running the turn can observe, because the request that asks
for the cancel may land on a different node than the turn. That is #2953's
problem to solve once, for every kind of run.

**Routing is structural, and the guard it replaces was not.** The old guard
kept a reply out of the wrong transcript by comparing a counter, and that only
held if the counter was current at the instant the reply landed. Writing each
reply to the thread it was asked in has no such instant. No timing lets a reply
reach the wrong thread, so the render-time ref write and its `eslint-disable`
are gone.

## Consequences

- A reply that lands after the person has left waits in its own workspace's
  thread. Returning shows the whole conversation, not only the last line.
- The workspace the person moved to is never handed a reply that is not its own.
- One thread holds at most one turn in flight. Two layers hold this: the
  composer is `disabled` while its thread is `pending`, and the submit handler
  refuses a submit that gets through anyway. Leaving no longer clears `pending`,
  so the race over one conversation id cannot happen.
- Two workspaces are two conversations. A turn running in one does not block
  the person asking in the other.
- A parked write from an abandoned turn keeps its notice in its own thread, and
  `navigate.refresh()` still runs wherever the person is standing, because the
  shell's waiting count spans the organization.
- A half-typed question belongs to the workspace it was typed in.
- Threads live in the flyout's component state. They survive a workspace switch,
  because the shell persists across one, but not a full reload. The conversation
  itself is persisted server-side, so reading it back on reload is additive work
  on top of this decision, not a change to it. (Superseded 2026-09-25 by the
  amendment below: the thread is now read back on reload.)
- **The spend on an abandoned turn is now a stated cost rather than a hidden
  one.** A turn nobody returns to still runs to completion. That is the price of
  never half-finishing a governed action. Until #2953 ships its cancel, a
  person has no way to stop paying for a turn they have asked. This decision
  does not change that. It was true before this decision too, because the old
  behaviour hid the reply but never stopped the turn.

## Amendment, 2026-09-25: the key and the reload (#4163, #3313)

"One thread per workspace" means one thread per workspace **id**, not per
`org/ws` slug pair. The flyout used to key its threads by the slugs in the URL,
so renaming a workspace stranded its thread, and any reply still in flight,
under a slug the shell would never compute again. `assistant-threads.ts` now
files each thread under the workspace's id, which `loadAssistantThread`
answers. Until that read answers, the slugs stand in, and anything written to
the stand-in moves with it to the id.

The same read restores the thread after a reload: it is the viewer's latest
active conversation in the workspace, read through `get_conversation`. "New
thread" empties the thread on screen and the next question opens a new
conversation. The old conversation stays on the record. Everything above about
routing a turn to the thread it was asked in is unchanged. Only the key it
routes by changed, to the id.

## Verification

`apps/app/src/features/shell/assistant-flyout.test.tsx` states the contract.
Each ownership test fails when the old behaviour, clearing a workspace's thread
on leaving, is put back: five cases, covering the reply, the conversation across
a round trip, the in-flight gate across a round trip, the per-workspace draft,
and the parked writes of an abandoned turn. The case that drives React's real
scheduler resolves a reply in the gap between a workspace switch committing and
its passive effects running. That gap is what the old guard existed to survive,
and the reply still reaches only its own thread.
