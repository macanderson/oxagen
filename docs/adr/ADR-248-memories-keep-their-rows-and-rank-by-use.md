# ADR-248: Memories keep their rows and rank by use

- **Status:** Accepted. Mac ruled on 2026-09-30 that memories rank by use.
  The mechanism below is the agent's reading of that ruling.
- **Date:** 2026-10-01
- **Owners:** steering, tacho
- **Supersedes in part:** ADR-206 decision 6 step 3 (the age drop) and
  decision 7 (the purge), and two consequences of ADR-238 (a deleted file's
  memory, and the age clock).
- **Related:** issue #4908 (lane MEM2), ADR-206, ADR-238, the memory
  collection spec (`memory-collection-spec.html` in oxageninc/roadmap,
  sections Use counting, Lifecycle, Data model, and Capabilities).

## Context

Mac ruled on 2026-09-30 that memories rank by how many times each one was
used or cited. Oxagen counted nothing for harness memories. It also could not
keep a count: ADR-206 decision 7 deleted every memory a memory PR cited once
the PR merged or closed, and the curator deleted a waiting memory once it had
waited `retire_after_days`. A memory file someone deleted kept its waiting
memory until one of those two deletes reached it (ADR-238).

## Decision

### Mac's rulings

1. **Memories rank by the number of times each one was used or cited.**
2. **Memories are not embedded, steer only the agent that wrote them, and
   reach other agents only as a steering record merged in git.** ADR-238
   records these.

### The agent's reading of the rulings

1. **A use is one run.** `agent.memory_uses` holds one row per memory, run,
   and signal: `read` (a run read the memory's file), `harness_count` (a
   harness counted a use itself, with no run), or `citation` (a run cited
   it). A memory's `use_count` is its distinct runs plus the `count` of its
   uses with no run. A run that reads a file five times adds one use, and the
   row's `count` keeps the five. The store recomputes `use_count` and
   `last_used_at` from the uses in the transaction that writes them, with the
   memory rows locked, so the two never disagree.
2. **Tacho counts a Claude Code read of a memory file.** The hook handler
   sees each `PostToolUse` of `Read`, `Grep`, or `Bash` that names a file in
   a Claude Code memory folder. Loading `MEMORY.md` is no use, because it
   lists every memory and uses none. A subagent's read counts for its root
   run. The daemon sends the uses with its five-minute memory scan to
   `record_tacho_memory_uses` (`POST /v1/tacho/memories/uses`).
3. **The host names the run by its root session's uuid.** The host never
   learns the `tse_…` id. The handler reads it from the host's own sessions.
   A use whose session row has not landed comes back as pending, and the
   daemon sends it again.
4. **A use goes to the memory the file holds now.** That is the file's
   waiting memory, else its newest memory that has not retired, else its
   newest memory. A retired memory that a run uses comes back.
5. **A memory keeps its row for life.** `agent.memories.state` is `waiting`,
   `in_pr`, `promoted`, `dismissed`, or `retired`. Nothing deletes a memory.
   - The curator's memory PR moves the memories it cites to `in_pr`.
   - A record that merges promotes its memories: they link to it by
     `promoted_lineage` and keep counting uses.
   - A record that does not merge sends its memories back to `waiting`, and
     its statements still join `memory_rejections`. A returned memory whose
     file has a newer waiting memory retires instead, because the file no
     longer holds its text.
   - A waiting memory that an active steering record already says links to
     that record and becomes promoted. Before, the curator deleted it.
6. **A memory retires for one of two reasons.** `deleted`: a full scan no
   longer found its file, or the file no longer holds its statement. `unused`:
   no run used it for `retire_after_days`, counted from its newest use, or
   from its capture when no run used it. A `deleted` memory comes back when
   its file holds the statement again. An `unused` memory comes back when a
   run uses it, or when its file changes and changes back. A daemon restart
   sends every file again, and that send alone brings back no `unused`
   memory.
7. **A full scan retires what it no longer finds.** Each scan sends its
   folder and every memory file it found. Each waiting or promoted memory of
   the host's agent from a file under that folder that the scan did not list
   retires. The daemon sends a scan only when it listed every folder without
   an error, because a scan that missed a folder would retire every memory in
   it. After such a scan the reader forgets the files it no longer found, so
   a deleted file that comes back unchanged is sent again.
8. **The curator fills its batch from the top of the ranking.** It ranks
   waiting memories by uses, then the newest use, then the newest capture,
   and groups them by lesson in that order. Only a memory with at least one
   use enters the batch.
9. **A memory file's frontmatter is kept.** Claude Code's `name`,
   `description`, and `metadata.type` (or a top-level `type`) become
   `label`, `summary`, and `memory_type`.
10. **`import` is a capture.** The Markdown importer's Memories target
    (#4907) stores statements with capture `import`. The value lands here so
    that change needs no second migration.
11. **`agent.memory_recalls` stays.** The issue proposed dropping it as
    unused. It is not: `recall_tacho_memories` stamps each memory record it
    serves there, the curator's stale and contradiction checks read it, and a
    settled memory PR stamps its lineages there (ADR-238).
12. **Tacho counts each Stella use as a citation (lane MEM4, #4911).**
    Stella keeps each workspace's memories, and the turns that used them, in
    `.stella/private/context.db`. Since its context schema 14 it shows both
    in two read-only views, `export_memories_v1` and `export_memory_uses_v1`
    (macanderson/stella#6646). Each live memory becomes a memory with source
    `stella:<lineage>`. Each use row is a turn that put the memory in the
    prompt, and the daemon sends it as a `citation` use. Stella names a turn's
    thread by its start time and process id, and Tacho names a Stella run by
    its process, so the daemon finds the run in its own registry by the pid
    and the time the turn finished. A use no run fits is dropped, because
    Oxagen recorded no run for it. A cursor in the agent's
    `stella-memory-cursors.json` keeps a restart from counting a use twice.

## Consequences

- A memory's count survives its promotion, its dismissal, and its file's
  deletion.
- A `remember`, `pull_request`, or `import` memory has no use signal, so it
  never enters the curator's batch. It reaches a steering record only once
  a person promotes it, which lane MEM5 builds. It retires
  `retire_after_days` after its capture, as it was dropped before.
- A Bash call that reads a memory file through a glob, a variable other
  than `HOME`, or a path built at run time is not counted.
- Two hosts of one agent with the same home path share a source (ADR-238).
  A full scan on one host retires a memory whose file only the other holds.
- The uses a daemon holds when it stops are lost. They wait at most five
  minutes before they are sent.
- No scan list goes out for Stella, since a `stella:<lineage>` source names
  no folder. A memory Stella forgets retires as `unused`, not `deleted`.
- A Stella turn from before Tacho watched the host, or from a run the
  registry has forgotten (a week after it ended), counts no use.

## Alternatives rejected

- **Drop `agent.memory_recalls` and count record recalls as memory uses.**
  Recall serves steering records, and a record's lineage is not a memory.
  Moving the retirement check onto memory rows would need a review time on
  each memory, and a record no memory carries would lose its stale clock.
- **A partial unique index on the waiting row of each source.** ADR-238
  rejected it, and the advisory lock still serializes two sends from one
  file.
- **Count every read.** A run that greps a file in a loop would outrank a
  memory ten runs read once. The row's `count` keeps every read, so the rule
  can change without new data.
- **Retire by the agent's sources across hosts.** A host sees only its own
  folders, so a scan limits itself to the folder it read.
