# ADR-181: The oxagen repository carries no .oxagen directory

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Amends:** ADR-137's storage decision (the six standing decisions as TOML files under `.oxagen/rules/` in this repository).
- **Related:** ADR-038 (the standing-decisions block in `AGENTS.md`), ADR-099 (a workspace is born with its main repository), ADR-137

## Context

ADR-137 stored the six standing decisions as context records under `.oxagen/rules/` in this repository. The same directory also held 50 memories that agents in this repository wrote, an agent definition, and a vendored copy of the `oxagen-branding` skill. The two `ctx.product.*` rules and `governance.toml` arrived through Context PRs from the workspace this repository was linked to.

On 2026-09-25 Mac uninstalled Oxagen from this machine, asked for that workspace to be purged, and set out to create a new workspace from a clean install. Mac asked for `.oxagen/` to be removed from every repository that tracked it: stella, oxagen-brand, oxagen-roadmap, context-graph-protocol, oxagen-arp, and this one. A tracked copy of the old workspace's steering would otherwise be pulled back into the new workspace, or conflict with what the new workspace writes.

## Decision

This repository no longer tracks a `.oxagen/` directory.

- The standing-decisions block at the end of `AGENTS.md` is the record of SCR-001 to SCR-006 in this repository. It keeps the SCR identifiers. Links that pointed at the TOML files now point at that block.
- The last committed copies of the removed files stay in history. `git show <commit>^:.oxagen/rules/ctx.scr.004-fix-over-file.toml` recovers one, where `<commit>` is the commit that removed the directory.
- A workspace linked to this repository may write `.oxagen/` again through `oxagen init`, `oxagen pull`, or a Context PR. That is the product working as designed. Whether a new workspace's records are committed here is decided when that workspace is linked.
- `.gitignore` keeps its two `.oxagen/` lines (`workspace.json` and `settings.local.json`), because `oxagen init` writes those files locally.

`scr-corpus-check` is unchanged in what it checks. It still fails when any of the five repositories carries `docs/scr/`. Only its message moves from `.oxagen/rules/` to `AGENTS.md`.

## Consequences

- The TOML form of the six records is gone from the tree. The block in `AGENTS.md` carries the same directives, and every harness already read that block rather than the TOML files.
- The memories and the vendored skill copy are gone from the tree. The canonical `oxagen-branding` skill lives in the house brand kit and in `.claude/skills/`.
- Agent definitions that persist memories under `.oxagen/memories/` (`break-fix`, the `eval-*` agents) now create that directory on their next write. A follow-up decides where those memories go.
