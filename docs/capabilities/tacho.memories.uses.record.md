# record_tacho_memory_uses

Count the memory files the runs on the calling host read, and retire the memories whose files a full scan no longer finds. The enrolled daemon sends this report every five minutes, after its memory scan.

**Surfaces:** api

**Input:** `host_enrollment_id`, up to 200 `uses`, and up to 8 `scans`. A use names the `harness`, the memory file's `path`, the `session_uuid` of the run's root session, the `count` of reads since the last report, and `used_at`, the time of the last read. A use may also name its `signal`: `read`, the default, or `citation`. A scan names the `harness`, the `root` folder it read (ending in a path separator), and up to 4,000 memory file `paths` under it.

**Output:** `recorded`, the uses stored. `unknown`, the uses of a file that holds no memory in the workspace, which are dropped. `pending`, the index of each use whose run Oxagen has not recorded yet. `retired`, the memories the scans retired.

The host API key must own the named active enrollment, and its creator must still hold the organization Owner or Admin role.

The daemon counts a Claude Code `Read`, `Grep`, or `Bash` call that names a memory file, from the `PostToolUse` hook. Loading `MEMORY.md` is no use. A subagent's read counts for its root run.

The daemon also reads Stella's `export_memory_uses_v1` view in each Stella workspace's `context.db`. Each row is a turn that put a memory in the prompt, and the daemon sends it as a `citation` use. Its `path` is the memory's lineage, so its source is `stella:<lineage>`. The daemon finds the run by the Stella process id in the row's thread id and the time the turn finished.

The handler reads each run's `tse_…` id from the host's own sessions. It stores the use against the memory the file holds now: the file's waiting memory, else its newest memory that has not retired, else its newest memory. Oxagen keeps one use per memory, run, and signal, so a run that reads a file twice adds one use. A memory's `use_count` is its distinct runs, and `last_used_at` is its newest use. The store recomputes both from the uses in the same transaction. A retired memory that a run uses comes back.

The daemon sends a scan only after it listed every memory folder without an error. Each waiting or promoted memory of the host's agent from a file under the scan's root that the scan did not find retires as `deleted`. It comes back when the file holds its statement again.

The daemon calls `POST /v1/tacho/memories/uses`. Each host gets 30 calls a minute on this path, separate from the memory upload, recall, and the control paths. See [ADR-248](../adr/ADR-248-memories-keep-their-rows-and-rank-by-use.md).
