# Skill resolution configuration

ADR-090 makes `.oxagen/skills.toml` the configuration of record. A missing file means off. The format below is version 1 of the repository source implementation. It does not grant tools, model tiers or spending authority.

```toml
version = 1
enabled = true
unbound_repo = "ask"

[[sources]]
id = "workspace"
path = ".oxagen/skills"

[[sources.skills]]
id = "review"
version = "1.0.0"
digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[search]
mode = "on_demand"
cutoff = 0.2
budget = 6000
limit = 10

[reflection]
enabled = false
use = "research"
retention_days = 30
```

Version 1 admits one source, the approved repository's `.oxagen/skills` directory. Registry sources require a separate transport and are not accepted by this implementation. Each approved skill has a unique id and version within that source, with a SHA-256 digest over its `SKILL.md` bytes after CRLF is normalized to LF. Configuration digests cover the exact TOML bytes read back from GitHub.

Unknown keys, duplicate TOML keys, duplicate source ids or pins, negative budgets, and an unbound-repository policy other than `ask` are refused. Reflection may only name research use with retention of 1 to 90 days. The fields reserve the accepted ADR-090 contract; this increment does not start reflection capture.

`update_skill_config` opens a unique proposal branch, or records the approved merged file. Initial import is allowed once per repository binding. Publication checks the binding again inside the database transaction, serializes workspace version allocation, and reuses a snapshot when the same commit is retried. A publication cannot overwrite an earlier version. A configuration-free workspace reads as off without a fabricated version.

`preview_skill_search` reads one current repository commit and selects a published configuration version. Changed digests and unapproved versions are removed before their descriptions reach the ranker. The current ranker uses deterministic query-token overlap. It makes no model call. The returned token estimate is constrained by the cumulative load budget, and the preview loads nothing into an agent.

The append-only Postgres tables are `skills.config_versions` and `skills.resolutions`. The repository reference is `repository_binding_id` because the current platform stores approved repository identity in `ingestion.repository_bindings`; this preserves the accepted version rather than inventing the future `wrk.repositories` table. Ordinary reads are tenant-scoped, and the application role has SELECT and INSERT privileges only.

This increment exposes the config and preview capabilities on API and MCP. The remaining #3098 work is agent run-start pinning and replay, the metered `search_skills` tool on the belt, interjection and answer delivery, research IAM and reflection quarantine with expiry, materialized skill delivery, and the Steering console. These integrations must use the same resolver and immutable snapshots.
