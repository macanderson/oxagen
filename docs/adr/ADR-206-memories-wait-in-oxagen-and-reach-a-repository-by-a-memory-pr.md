# ADR-206: Memories wait in Oxagen and reach a repository by a memory PR

- **Status:** Accepted. Superseded in part by ADR-238 (2026-09-30): decision
  10's recall of unreviewed memories, and the last sentence of decision 11.
  Superseded in part by ADR-245 (2026-10-01): decision 7's purge, and the age
  drop in decision 6 step 3.
- **Date:** 2026-09-26
- **Owners:** steering, tacho
- **Related:** issue #4458 (lane S6), issue #4434 (the steering repo),
  ADR-187 (steering record is the only name), ADR-189 (gateway attribution),
  ADR-093 (one assembler), ADR-101 (four harnesses), ADR-141 (Cursor's stop
  hook), ADR-025 (verb-first names).

## Context

The steering repo spec lets an agent keep what it learned in a run. An agent
writes a `memory/v1`, and at the end of a run it writes a `reflection/v1` that
grades its work and its tools and carries lessons. A curator later proposes the
lessons worth keeping as steering records in one memory PR. The spec leaves
four things to the build: where memories wait, how Oxagen knows which agent and
run wrote one, when a harness is asked to reflect, and what happens to a
memory once a person has decided on it.

The in-app `agent.memory.*` capabilities keep `:AgentMemory` nodes in Neo4j for
the assistant. They are a different store with a different reader, and this
record leaves them as they are.

## Decision

1. **Memories and reflections wait in Postgres.** Five tables in the `agent`
   schema, each with the workspace tenant policy:
   `memories` (`mem_`), `memory_reflections` (`rfl_`), `memory_prs` (`mpr_`),
   `memory_rejections`, and `memory_recalls`. A memory is a short queue item:
   the curator counts, lists, cites, and deletes memories by workspace, and
   nothing walks a graph. The run is a public id (`arun_` or `tse_`), as on
   `agent.interjections`, because no one table holds both kinds of run. The
   migration is `20260927021500_steering_memories.sql`.
2. **Capture reads the run's record, never the tool input.** An agent calls
   `remember_lesson` for one lesson and `record_reflection` at the end of a
   run. Both contracts write nothing (`mutates: false`), and both handlers
   answer only a call the local gateway serves for a run Oxagen watches. When
   the run seals, `run.reflect` (on `cost/run.sealed`) reads each call from
   the run's frames, checks its input against the contract again, and stores
   it. The agent is the lineage the run recorded, and the run is the run's
   public id. A call Oxagen denied or that failed is not stored. Evidence is
   `frame:<run>/<seq>`, and a call that names no frame cites its own.
3. **The names are `remember_lesson` and `record_reflection`.** `save_memory`
   and `recall_memory` already name the in-app capabilities, and ADR-025 wants
   a verb and an object. A bare `remember` or `reflect` would have been the
   only unqualified verb in the catalogue.
4. **Claude Code is asked to reflect once, and only on a signal.** Tacho's
   Stop hook blocks the first stop of a Claude Code session once, and only
   when the session shows a failed tool call, a correction from the person, a
   retry loop of 3 identical calls, or a policy denial, and has not called
   `record_reflection`. The reason it returns asks the agent to call
   `record_reflection`. A stop with `stop_hook_active`, a replayed hook, and a
   custom agent are never blocked. For Codex, Cursor, and stella, and for a
   Claude Code run that did not answer the ask, `run.reflect` writes the
   reflection from the run's digest on the fast tier, with `source: digest`,
   when the run shows the same signals.
5. **Tool grades never steer.** A reflection's tool grades and tool feedback
   stay on its row for the tool server's owner. The curator and recall never
   read them.
6. **The curator opens one memory PR a day.** `memory.curate` runs daily and
   when 20 memories are waiting in a workspace. It runs only where the steering
   repo holds `steering/governance.toml`, and in this order:
   1. It settles each open memory PR (decision 7).
   2. It proposes archiving stale or contradicted records (decision 9).
   3. It drops each waiting memory that an active record already says, and
      each one that has waited longer than `retire_after_days`.
   4. It groups the rest into records. Memories that say the same thing become
      one record that cites each of them. The memories themselves are never
      merged.
   5. It cites at most `batch_size` memories. The rest wait for the next day.
   6. It writes each record to
      `steering/memory/<repository or workspace>/<area>/<lineage>.md`, where
      the area is the first `applies_to` segment, else the first tool's
      server, else `general`. A `code-rule`, `business-rule`, or `fact`
      keeps its kind, and any other kind becomes `memory`. Each record is
      `force: info`, `status: active`, and `origin: inferred`, and its
      `provenance.memories` copies each cited memory's agent, run, statement,
      and evidence, with a null kept as null.
   7. It opens the PR from `memory/<date>`, one branch per day.
7. **A decided PR purges its memories.** When a memory PR merges, the curator
   reads each record's path at the merge commit. A record that is there
   merged, and its lineage gets a `memory_recalls` row stamped at the merge. A
   record the person removed before merging did not merge. When a memory PR
   closes unmerged, no record merged. Either way the curator deletes every
   memory the PR cited. A record that did not merge leaves the hash of each
   statement it cited in `memory_rejections`. The hash is the sha256 of the
   statement in lowercase, with punctuation removed and whitespace collapsed.

   *Superseded in part by
   [ADR-245](./ADR-245-memories-keep-their-rows-and-rank-by-use.md) on
   2026-10-01.* No memory is deleted. A merged record promotes its memories,
   a record that did not merge sends them back to waiting, and an active
   record that already says a waiting memory links it. A memory no run used
   for `retire_after_days` retires.
8. **A rejected statement needs new evidence.** The curator proposes a
   rejected statement again only when memories with its hash came from at
   least 2 runs after the rejection. One agent repeating itself in one run is
   not new evidence.
9. **Retirement is proposed, never applied.** The curator proposes archiving a
   record under `steering/memory/` in the next memory PR when a reflection's
   lesson contradicts it, or when no run recalled it within
   `retire_after_days`. A lesson contradicts a record when their words overlap
   by half or more and exactly one of them says never, not, avoid, stop, or no
   longer. The edit sets `status: archived`. A person merges or closes it like
   any other record in the PR.
10. **Recall is ranked by relevance and age.** `recall(request)` answers at
    most 5 memories and 800 tokens, all within the request's scope: its
    repository, its tools, and the paths it names. Each candidate scores its
    word overlap with the request, times a weight that halves every
    `half_life_days` (30 unless set). A merged record ages from the merge, and
    an unreviewed memory ages from its capture. An unreviewed memory reaches
    only the agent that wrote it, only while `recall_unreviewed` is
    `same-agent`, and never when its agent is null. The in-app agent receives
    no workspace memories. Recall counts live in `memory_recalls`, never in a
    file.

    *Superseded in part by
    [ADR-238](./ADR-238-oxagen-collects-harness-memories-and-recalls-none-of-them.md)
    on 2026-09-30.* Recall answers merged steering records only. No memory
    that waits for review reaches any agent, and `recall_unreviewed` left
    governance/v1.
11. **Two more sources feed the same table.** A memory found by the code
    repository check is stored with capture `pull_request`, and a memory
    Tacho's local gateway reads from a harness's memory folder is stored with
    capture `local_gateway` and no run. Tacho reads Claude Code's
    `~/.claude/projects/<project>/memory/*.md`, skips `MEMORY.md`, and sends
    each file once per content digest.

    *Superseded in part by
    [ADR-238](./ADR-238-oxagen-collects-harness-memories-and-recalls-none-of-them.md)
    on 2026-09-30.* Every enrolled host scans, with no flag. Tacho sends a file
    each time its text changes, and the file keeps one waiting memory whose
    text each send replaces.

## Consequences

- A lesson an agent sends from a script with an API key is refused. There is
  no watched run to attribute it to.
- A lesson reaches the curator only after its run seals, so a run that never
  seals keeps its lessons in its frames and nowhere else.
- A run whose retention policy keeps only digests of tool bodies leaves
  `run.reflect` nothing to read, so its lessons are lost. The digest fallback
  still grades the run.
- One memory PR a day bounds review work. A workspace that writes more than
  `batch_size` memories a day builds a queue that the age cap trims.
- Codex, Cursor, and stella get a digest reflection and no ask. Cursor's
  `stop` hook can continue the agent (ADR-141), so Cursor can take the ask
  later. Codex and stella have no stop hook that continues the agent.
- Claude Code is the only harness whose memory folder Oxagen knows. Codex,
  Cursor, and stella memories reach Oxagen through `remember_lesson` alone.
- The duplicate test is word overlap, not meaning. Two statements that say
  the same thing in different words become two records, and a reviewer sees
  both in one PR.

## Alternatives rejected

- **Write the memory in the handler.** The handler would take the agent and
  run from its context, which a gateway session gives only when attribution
  (ADR-189) resolves the run. Reading the frame after the seal uses the record
  every other reader trusts, and a denied call never stores a lesson.
- **Keep memories in Neo4j beside `:AgentMemory`.** The two stores have
  different readers and different lifetimes, and a queue that is purged every
  day gains nothing from a graph.
- **Merge duplicate memories into one.** The spec keeps each memory's agent,
  run, and evidence, and a merged memory would lose them.
- **Ask every harness to reflect.** Only Claude Code's Stop hook can hold the
  agent for one more turn with a reason. A digest reflection costs one fast
  model call and asks nothing of the agent.
- **Embed statements for the duplicate test.** It would bill an embedding for
  each memory and each record every day. Word overlap is enough to group what
  one agent repeats, and a person reviews every record.
