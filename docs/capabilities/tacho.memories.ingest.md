# ingest_tacho_memories

Store one memory that a harness wrote on the calling host. The enrolled daemon's memory reader watches the folders where Claude Code, Codex, Cursor, and Stella keep their own memories. It sends each new or changed file here as one statement.

**Surfaces:** api

**Input:** `host_enrollment_id`, the `harness` that wrote the file, the file's `path` on the host, and the memory `statement` (1 to 2,000 characters after trimming).

**Output:** `stored`, which is `false` when the workspace already holds the same statement from the same file.

The host API key must own the named active enrollment, and its creator must still hold the organization Owner or Admin role. The handler stores the memory with capture `local_gateway`, the host's agent as its agent, no run, and `<harness>:<path>` as its source. The memory waits for the curator like any other memory. A statement the memory runner refuses answers 400, and the daemon does not send that file again until it changes.

The daemon calls `POST /v1/tacho/memories`. Each host gets 30 calls a minute on this path, separate from the command poll and the bundle refresh. See [ADR-206](../adr/ADR-206-memories-wait-in-oxagen-and-reach-a-repository-by-a-memory-pr.md).
