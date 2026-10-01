# ingest_tacho_memories

Store one memory that a harness wrote on the calling host. The enrolled daemon's memory reader watches the folders where Claude Code, Codex, Cursor, and Stella keep their own memories. It sends each new or changed file here as one statement.

**Surfaces:** api

**Input:** `host_enrollment_id`, the `harness` that wrote the file, the file's `path` on the host, and the memory `statement` (1 to 2,000 characters after trimming). A Claude Code memory file's frontmatter can add `label` (its `name`, up to 200 characters), `summary` (its `description`, up to 1,000 characters), and `memory_type` (its `metadata.type`, such as `feedback`).

**Output:** `stored`, which is `false` when the workspace already holds the same statement from the same file.

The host API key must own the named active enrollment, and its creator must still hold the organization Owner or Admin role. The handler stores the memory with capture `local_gateway`, the host's agent as its agent, no run, and `<harness>:<path>` as its source. The memory waits for the curator like any other memory. A statement the memory runner refuses answers 400, and the daemon does not send that file again until it changes.

A file keeps one waiting memory. A new statement from the same file replaces the waiting memory's statement, hash, and dedupe key, and the memory keeps its id, the time it was first stored, and its uses. A memory that an open memory PR cites, a promoted memory, and a dismissed memory keep their text, and the new statement becomes a new waiting memory. When the file goes back to text another memory of the file holds, that memory holds the file's text again and the waiting memory retires. A memory retired because its file was gone comes back when the file holds its statement again (ADR-245).

Every enrolled host's daemon reads the memory folders every five minutes, and no setting turns the scan off. Claude Code's folder is `~/.claude/projects/<project>/memory/`, or the one under `CLAUDE_CONFIG_DIR`, and `MEMORY.md` is skipped. The daemon sends a file again each time its text changes, including back to text it held before.

The daemon calls `POST /v1/tacho/memories`. Each host gets 30 calls a minute on this path, separate from the command poll and the bundle refresh. See [ADR-206](../adr/ADR-206-memories-wait-in-oxagen-and-reach-a-repository-by-a-memory-pr.md), [ADR-238](../adr/ADR-238-oxagen-collects-harness-memories-and-recalls-none-of-them.md), and [ADR-245](../adr/ADR-245-memories-keep-their-rows-and-rank-by-use.md).
