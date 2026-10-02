# ADR-238: Oxagen collects harness memories and recalls none of them

- **Status:** Accepted. Mac ruled on 2026-09-30. ADR-248 (2026-10-01)
  replaces two consequences: a deleted file's memory now retires within one
  full scan, and a memory's age now runs from its newest use.
- **Date:** 2026-09-30
- **Owners:** tacho, steering
- **Supersedes in part:** ADR-206 decision 10 (recall of unreviewed
  memories) and the last sentence of ADR-206 decision 11 (one send per
  content digest).
- **Related:** issue #4903, ADR-206, the memory collection spec
  (`memory-collection-spec.html` in oxageninc/roadmap, lane MEM1, PR
  oxageninc/roadmap#291), PR #4893.

## Context

ADR-206 gave Oxagen a queue of memories in `agent.memories`, a curator that
proposes them as steering records, and a Tacho reader for the memory files
Claude Code writes under `~/.claude/projects/<project>/memory/`. Oxagen still
collected none of them, for three reasons.

1. The daemon started its five-minute memory scan only when
   `TACHO_MEMORY_CAPTURE=1` was set, and nothing deployed that value.
2. The dedupe key of a `local_gateway` memory is its capture, its source, and
   its statement's hash. Each edit of one memory file stored one more waiting
   memory, and the old text stayed in the queue.
3. Ingest gave each memory the host's agent, and `rankRecall` returned an
   unreviewed memory to that agent on every prompt while `recall_unreviewed`
   was `same-agent`, the default. Claude Code already loads its own memory
   folder, so the agent would read the same memory twice.

## Decision

### Mac's rulings

Mac ruled on each of these on 2026-09-30.

1. **No core capability sits behind a flag while Oxagen has no customers.**
   The memory scan runs on every enrolled host. `TACHO_MEMORY_CAPTURE` is
   gone from the daemon, the env registry, and `.env.example`.
2. **Memories do not steer agents in memory form.** A memory steers only the
   agent that recorded it, and the harness already does that.
3. **A memory reaches other agents only once it is promoted** into a steering
   record in git.
4. **Memories are not embedded.**
5. **Memories will rank by how often they were used or cited.** A later lane
   builds the counting.

### The agent's reading of the rulings

These follow from Mac's rulings. They are the agent's reading, not Mac's
words.

- **Oxagen recalls no memory.** `recall_tacho_memories` answers merged memory
  records from the published steering, and nothing else. `rankRecall` takes
  steering records as its only candidates, and `recallMemories` never reads
  the waiting queue. The answer's `source` is always `record`. The contract's
  enum still lists `memory`, so the published answer schema stays as it was.
- **A `remember_lesson` memory now steers nobody until it is promoted.**
  Codex, Cursor, and Stella keep their lessons in Oxagen through
  `remember_lesson`, because Oxagen knows no memory folder of theirs. Before
  this record, recall could hand a Codex agent's lesson back to it at its next
  prompt. Now such a lesson steers no agent until a person merges its memory
  PR.
- **`recall_unreviewed` leaves governance/v1.** Nothing reads it after this
  change. No Oxagen template ever wrote it, and on 2026-09-30 no steering
  repository in Mac's accounts carried it. The schema stays at v1, because a
  file that never held the key reads the same. A hand-written
  `steering/governance.toml` that still carries the key fails the steering
  check at that line, and the fix is to delete the line. `regulated` mode no
  longer has a recall setting to force off.

### One waiting memory per memory file

The issue set the rule: a new statement from the same `<harness>:<path>`
replaces the waiting memory's statement, hash, and dedupe key, and a memory an
open memory PR cites keeps its text. The agent chose how the store does it.

- `replaceSourceMemory` in `packages/handlers/src/memory/store.ts` does the
  work in one transaction. `ingestMemories` calls it for each
  `local_gateway` memory. A `pull_request` memory still adds a row per
  statement, because one pull request holds many lessons.
- A Postgres advisory transaction lock on the workspace, the capture, and the
  source serializes two sends from one file, so the second reads the row the
  first wrote.
- The waiting row keeps its id and its `created_at`. Every other content
  column takes the new draft's value.
- When the file goes back to a statement that an open memory PR cites, the
  update would collide with the cited row's dedupe key. The store deletes the
  waiting row instead, because the cited row holds the file's text again.
- A source can hold several waiting rows written before this record. The
  store keeps the oldest, gives it the new text, and deletes the rest, which
  hold text the file no longer says.
- No migration. Every column the rule needs already exists.
- Tacho's memory reader keeps the digest it last sent for each file path,
  instead of one set of every digest it ever sent. A file edited back to an
  earlier text is sent again, and two files with the same text are sent once
  each.

## Consequences

- An enrolled host with Claude Code memory files sends each one within one
  scan of the daemon's start, with no environment variable set.
- Editing a memory file updates its waiting memory in place. The memory PR a
  person reviews shows the file's latest text.
- Claude Code loses nothing: it reads its own memory folder at every session.
  A lesson written through `remember_lesson` steers no agent until a person
  merges its memory PR.
- A waiting memory's age runs from the first time its file was stored, so the
  curator's `retire_after_days` drops a file's memory that long after its
  first capture, however often the file changed.
- A file the person deletes leaves its waiting memory until the curator cites
  it or the age limit drops it.
- The source is the harness and the file's path on the host. Two hosts in one
  workspace with the same home path and project share a source, and each
  host's edit replaces the other's waiting text.
- `recall_tacho_memories` still stamps each record it serves in
  `memory_recalls`, so the retirement check keeps its counts.

## Alternatives rejected

- **Keep `recall_unreviewed` accepted with no effect.** The schema is
  strict, so keeping the key would have spared a file that carries it. No
  such file exists, and a key that parses and does nothing is a setting with
  nothing behind it.
- **A partial unique index on waiting `local_gateway` rows.** It needs a
  migration that first deletes duplicate rows already stored. An insert that
  loses the race on such an index stores nothing, so the newer text would be
  lost. The advisory lock gives the newer text the row.
- **Reset `created_at` on each edit.** A file edited every day would never
  reach the age limit, and its place in the curator's oldest-first queue
  would move back with each edit.
- **Keep the environment variable and default it on.** Mac's first ruling
  rules out the flag, not only its default.
