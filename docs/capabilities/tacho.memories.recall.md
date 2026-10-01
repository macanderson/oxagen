# recall_tacho_memories

Return the memory records most relevant to one prompt on the calling host. Every item is a steering record that a person merged. A memory that waits for review is never in the answer (ADR-238). The enrolled daemon asks once for each live prompt of Claude Code and Codex, and hands the answer to the agent as additional context. Stella's and Cursor's prompt answers carry no text to the agent, so the daemon does not ask for their prompts.

**Surfaces:** api

**Input:** `host_enrollment_id`, the `repository_digests` of the repository the prompt runs in (at most 8), the `tools` the session has called (at most 64), the `paths` it has touched relative to the repository root (at most 64), and the prompt's `text` (at most 8,000 characters).

**Output:** `items`, most relevant first. Each item has an `id` (the record's lineage), a `source`, a `statement`, a `score`, and its size in `tokens`. `source` is always `record`. The schema still lists `memory`, which named a memory that waited for review before ADR-238.

The host API key must own the named active enrollment, and its creator must still hold the organization Owner or Admin role. The handler reads the memory records from the workspace's and the organization's published steering. A workspace record replaces an organization record of the same lineage. Each record served counts as recalled, so an often-used record does not go stale.

The remote never leaves the host. The daemon digests its `origin` remote twice, as written and with the path lowercased on GitHub and GitLab. The handler digests each record's repository the same way and matches the two sets. An empty list matches no record scoped to a repository.

The daemon calls `POST /v1/tacho/memories/recall` and waits 500 ms for the answer. A slow, failed, or refused call gives the prompt no recalled memories, and the prompt goes on. Each host gets 120 calls a minute on this path, separate from the memory upload, the command poll, and the bundle refresh. See [ADR-206](../adr/ADR-206-memories-wait-in-oxagen-and-reach-a-repository-by-a-memory-pr.md) and [ADR-238](../adr/ADR-238-oxagen-collects-harness-memories-and-recalls-none-of-them.md).
