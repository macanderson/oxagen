# Root agent lessons

- [2026-07-21] Before calling a portable artifact canonical, distinguish filesystem ownership from managed immutable source versions and transactional database projections. (source: reflections/2026-07-21-toml-artifacts-lifecycle-design.md, agent: root)
- [2026-07-21] For security-model cutovers, separate additive schema expansion from the guarded reset/contract migration, but make policy mutations and runtime admission contend on the same version row so intermediate commits stay buildable without creating a dual-read or stale-allow path. (source: reflections/2026-07-21-enterprise-agent-iam-phase1-plan.md, agent: root)
