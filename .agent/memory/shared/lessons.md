# Shared lessons

- [2026-07-21] In this workspace, pass Vitest file filters as positional arguments through `pnpm --dir <package> exec vitest run <file>`; `test:unit -- <file>` can forward a literal separator and unintentionally run the full package suite. (source: codex/reflections/2026-07-21-stella-telemetry-intake-task-5.md, agent: codex)
- [2026-07-21] An integration hook that skips after a service ping must have a timeout longer than the client's transport timeout, or an unavailable dependency turns the intended skip into a hook failure. (source: codex/reflections/2026-07-21-stella-telemetry-intake-task-5.md, agent: codex)
- [2026-07-21] Separate blocking `before_finalize` work from durable post-commit `after_turn` observation; commit terminal state and outbox obligations atomically. (source: root/reflections/2026-07-21-toml-artifacts-lifecycle-design.md, agent: root)
- [2026-07-21] Foreign tool permissions can be one-to-many classes; map them only through exact audited target sets and intersect with live tools, entitlements, and IAM. (source: root/reflections/2026-07-21-toml-artifacts-lifecycle-design.md, agent: root)
