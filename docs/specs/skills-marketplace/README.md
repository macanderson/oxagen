# Skills Marketplace & Workspace Skill Management

**Parent ticket:** OXA-1733
**Status:** Draft spec — not yet in active implementation

---

## What this is

This directory contains the product specification for the Skills Marketplace and in-app skill management surface. It covers:

- Installable skills as a first-class `agent_skill` plugin type in the marketplace
- Workspace-seeded editable copies of built-in skill templates
- Immutable version history with an explicit pinned active version
- In-app management UI (browse, edit, version, rollback)
- Cross-surface capability parity (app / API / MCP)
- Telemetry foundation (load events, token burn, latency, last-used)

## Documents

| File | Description |
|------|-------------|
| [SPEC.md](./SPEC.md) | Full product and engineering spec — start here |

## Related

- [ADR-008 — Skills filesystem-first](../../adr/ADR-008-skills-filesystem-first.md)
- [ADR-013 — Oxagen Plugins capability packs](../../adr/ADR-013-oxagen-plugins-capability-packs.md)
- [Playbook Designer SPEC](../playbook-designer/SPEC.md) — marketplace pattern reference
