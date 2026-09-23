# ADR-101: Claude Code, Codex, Cursor and Stella are the four first-class harnesses

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform, evidence
- **Related:** ADR-043 (Oxagen governs agents, it does not run them), ADR-078
  (wrapped and connected tiers), ADR-141 (what counts as an installed Cursor,
  where a Cursor steer lands, and how the bridges survive a checkout without
  POSIX symlinks), `packages/tacho/src/wire.ts`,
  `packages/tacho/src/claude-code/cursor-adapter.ts`,
  `packages/tacho/src/host/cursor-writer.ts`,
  `packages/database/atlas/migrations/20260918210000_tacho_sessions_runtime_cursor.sql`,
  `packages/database/atlas/migrations/20260918210100_agents_harness_codex_cursor.sql`

## Context

Oxagen wraps an agent by installing a hook in the harness that runs it. Until
this change Tacho wrapped three harnesses: Claude Code, Codex and Stella.
Cursor appeared only as an MCP client in the install instructions, so a
Cursor session was never recorded, never refused, and never billed.

Cursor's agent now has a hook surface close to Claude Code's
(cursor.com/docs/agent/hooks, read on 2026-09-18). The IDE and the
`cursor-agent` CLI both read `~/.cursor/hooks.json`, and `preToolUse` sees
every tool call, including Cursor's own shell and file edits. That is the bar
for the wrapped tier in ADR-078.

The same gap existed one level up. Oxagen and this repository keep agents,
skills, steering and commands in Claude Code's layout (`.claude/`,
`CLAUDE.md`). Each harness reads a different set of paths:

| Artifact | Claude Code | Codex | Cursor | Stella |
|---|---|---|---|---|
| Steering | `CLAUDE.md`, which imports `AGENTS.md` | `AGENTS.md` | `AGENTS.md`, `.cursor/rules/*.mdc` | `AGENTS.md`, `CLAUDE.md`, `.stella/rules/` |
| Skills (`SKILL.md`) | `.claude/skills/` | `.agents/skills/` | `.cursor/skills/`, `.agents/skills/`, and `.claude/skills/` | `.stella/skills/`, adopted from `.claude/` and `.agents/` by `stella init` |
| Subagents | `.claude/agents/` | none documented | `.cursor/agents/` and `.claude/agents/` | `.stella/agents/`, adopted from `.claude/` |
| Commands | `.claude/commands/` | none in the repo | `.cursor/commands/` | `.stella/commands/`, adopted from `.claude/` |
| MCP servers | `.mcp.json`, `~/.claude.json` | `~/.codex/config.toml` | `.cursor/mcp.json`, `~/.cursor/mcp.json` | `stella.toml` |
| Tacho hooks | `~/.claude/settings.json` | `~/.codex/hooks.json` | `~/.cursor/hooks.json` | `~/.stella/stella.toml` |

So Codex could not see this repository's skills, and Cursor could not see
`CLAUDE.md`, which carries most of the operating rules.

## Decision

1. **Four harnesses are first-class:** Claude Code, Codex, Cursor and Stella.
   Each is a member of `WRAPPED_HARNESSES`, `TACHO_RUNTIMES`, the
   `tacho.sessions` runtime check, and the agent-registry harness enums.
   Claude Desktop stays a connected harness (ADR-078).
2. **Cursor is wrapped like Stella, through an adapter.** Its payload and its
   answers differ from Claude Code's, so `tacho-hook --harness cursor`
   translates both ways in `cursor-adapter.ts`. The recorder, the policy
   evaluator and the daemon keep reading one payload shape. Cursor's tool
   names are mapped to Claude Code's (`Shell` to `Bash`, `MCP:<tool>` to
   `mcp__<server>__<tool>`), so one policy rule governs every harness.
3. **A policy `ask` is a refusal in Cursor.** `preToolUse` accepts only
   allow or deny, and Cursor reads a malformed answer as a block. The adapter
   answers every permission event with one of the two, and answers `ask` with
   deny plus the reason.
4. **Cursor's model calls are not routed.** Cursor sends model traffic
   through its own backend, and it has no base-URL setting for that path.
   Tacho records Cursor's actions through hooks. It does not meter Cursor's
   model spend.
5. **Claude Code's layout is the canonical source, and every artifact
   Oxagen exports must load in all four harnesses.** Where a harness reads the
   canonical path, nothing else is written. Where it does not, a bridge points
   at the canonical file rather than copying it:
   - `.agents/skills` is a symlink to `.claude/skills`, for Codex.
   - `.cursor/rules/oxagen.mdc` always applies and references `CLAUDE.md`, for
     Cursor.
   - `.cursor/commands` is a symlink to `.claude/commands`, for Cursor.
   - `AGENTS.md` tells Codex and Cursor to read `CLAUDE.md`.

## Consequences

- A new harness-facing feature (a skill export, an agent definition file, a
  steering rule, an MCP entry, a hook) is not done until it loads in all four
  harnesses, or its PR names the harness that cannot load it and why.
- Cursor walks `.agents/skills` and `.claude/skills`, so it finds this
  repository's skills twice under the same names. The duplicate is the cost
  of Codex seeing them at all.
- The agent registry's generator (`register_agent` v2) is not written yet.
  When it is, it emits the per-harness files in the table above. Until then
  the canonical `.oxagen/agents/<slug>.toml` is the only file it commits.
- Update, 2026-09-23 (#3501): the subagent generator now exists for the
  definition's two write paths. `propose_agent` (creation) and
  `commit_agent_definition` (editing) both call `subagentFileFor` in
  `packages/oxagen/src/contracts/agent.propose.ts`. For a Claude Code, Cursor
  or Stella agent it writes `.claude/agents/<slug>.md` beside the definition
  on the same branch. For Codex it writes nothing, because Codex documents no
  subagent file. `register_agent` still writes no file.
