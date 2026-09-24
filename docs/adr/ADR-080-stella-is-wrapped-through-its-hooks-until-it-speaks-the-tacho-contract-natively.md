# ADR-080: Stella is wrapped through its hooks until it speaks the Tacho contract natively

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** `docs/specs/tacho/spec.md` §10 (Stella), `oxagen-roadmap:docs/oxagen/specs/tacho/oxagen-trace-drain.md`
  §9 (the v0/v1/v2 transport ranking), `docs/specs/oxagen-desktop/spec.md` §6 (the wrapper
  table), ADR-033 (the Rust engine as agent core), ADR-043 (runtime excision — Oxagen
  governs agents, it does not run them), ADR-053 (the in-app agent on `stella-serve`)

## Context

Tacho's spec already describes two different ways Stella can sit under Oxagen's
control, and they are not the same maturity. §10 says Stella "implements this
contract natively" through `tacho-core`: the executor's `tool.call.requested`
bus event is the `PreToolUse` equivalent, `policy.evaluated` maps to
`policy_decision`, and its `ApprovalRequest`/`ApprovalResponse` types carry
elevation. That is a description of work on the `macanderson/stella` side that
had not landed. `oxagen-trace-drain.md` §9 independently ranks a hook-based
transport as "v0 … build this first, as a spike to validate §6–§8, then
discard it. It does not ship as the product," and names `stella serve` (v2,
already built) as the durable path once Oxagen runs the engine directly.

Both documents point the same direction — a hook is the stopgap, native
`tacho-core` integration is the destination — but neither commits Oxagen to
shipping the stopgap. Meanwhile the desktop app (`docs/specs/oxagen-desktop/spec.md`)
already wraps Claude Code and Codex through settings-file hooks, and extending
that same mechanism to Stella costs nothing the app does not already pay for:
one more entry in the harness list, one more settings writer alongside the
Codex one. Waiting for `tacho-core` blocks Stella from appearing in the
Wrapped agents panel, in `tacho status`, and in the fleet record at all, for
however long the native integration takes on the other repo — a dependency
this repo does not control and should not gate its own release on.

The same question extends past the three named harnesses: any agent that is
not Claude Code, Codex, or Stella needs a way in that costs the agent author
nothing but a subprocess call, since Oxagen cannot write a settings file for
a harness it has never heard of.

## Decision

### 1. Stella wraps through the same hook mechanism as Claude Code and Codex

`enroll --harness stella` writes a marker-delimited block into
`~/.stella/stella.toml` (or `~/.stella/settings.json` when only that file
exists), the same way the Codex writer merges into `~/.codex/hooks.json`
without touching an entry it did not write. The hook command is
`tacho hook --enrollment tch_… --harness stella`; the events wrapped are
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact,
SubagentStart, and SubagentStop. This is the same `client_attested`
enforcement tier as Claude Code and Codex: Tacho's spec §10 already carves
out this tier for "a workstation Stella session," reserving `gateway` tier
for a `stella-serve` session by construction. Wrapping a workstation Stella
process through its hooks costs no Stella release and no protocol change;
it is a settings file and a CLI flag on the Oxagen side alone.

### 2. Two consequences follow directly from what Stella's hook payload does not carry

Stella's hook payload carries no `session_id` and fires no `SessionEnd`
event (the desktop spec's §6 table lists both gaps against the other two
harnesses). Two things follow, and both are accepted rather than worked
around:

- **The session is keyed on the wrapped process, not on a session id.**
  It opens at the first hook call and closes when that process exits.
- **An interactive, multi-session Stella process shares one chain.** If a
  single long-running Stella process opens more than one logical
  conversation, Tacho cannot tell them apart until Stella's own protocol
  carries a session id, so they land as one continuous chain in the fleet
  record rather than as separate sessions.

Both are named limits of the hook path specifically. They are not present
in Claude Code or Codex's hooks, and they go away automatically once
Decision 3 below supersedes this one, because `tacho-core` carries its own
session identity.

### 3. `tacho-core` is the superseding path, not an alternative to weigh again

Tacho's spec §10 already describes the native integration: the executor's
bus events map directly onto the Tacho contract, and the Stella-repo plan
that lands it is a numbered sub-plan of that spec (plan §PR 9) with its own
`docs/spec/` companion on `stella`, following the `serve-surface.md` pattern
ADR-053 already established for `stella-serve`. This ADR does not re-open
that decision or restate its design; it exists to record that the hook path
ships now, deliberately, as the interim mechanism that path replaces. When
`tacho-core` lands, `--harness stella` becomes a native session mapped
straight from bus events, the settings-file writer and its marker block
retire, and the two consequences in Decision 2 close along with it.

### 4. Any other agent wraps the same way a custom integration always would: call the hook directly

An agent that is none of the three named harnesses has no settings file
Oxagen can write into, because Oxagen does not know the harness exists. The
general answer is `tacho hook --agent <name>` (`<name>` matching
`^[a-z0-9][a-z0-9._-]{0,63}$`), called directly by the agent's own process
around each step: `SessionStart`, `UserPromptSubmit`, `PreToolUse` before
each tool call, `PostToolUse` after, `Stop`, and `SessionEnd`. The payload
on stdin is the same shape the Claude Code hook already sends, and the
answer on stdout follows the same decision vocabulary
(`hookSpecificOutput.permissionDecision`, `{decision: "block"}`,
`{continue: false}` / `additionalContext`). The session is labelled
`runtime = custom`, `agent.harness = <name>`. The machine must already be
enrolled; `tacho hook` reads the host credential itself, so the calling
agent never handles one. This is the same `client_attested` tier as the
three named harnesses, and it is the general mechanism the Stella hook in
Decision 1 is itself an instance of — Stella is simply a harness Tacho
knows the settings-file shape of, and a custom agent is one it does not.

## Alternatives

**Wait for `tacho-core` and ship no Stella wrapper until then.** Rejected.
It gates a desktop-app feature that costs nothing extra to ship on a
dependency this repo does not control, and it leaves Stella runs completely
invisible to the fleet record in the meantime — the exact gap Tacho exists
to close.

**Route Stella through `stella-serve` instead of a workstation hook.**
Rejected for this case, not in general. `stella-serve` already covers the
in-app agent under ADR-053 and any future Oxagen-hosted agent run. It does
not cover a developer running Stella from their own terminal, which is the
case this ADR is about; `oxagen-trace-drain.md` §9 makes the same
distinction explicitly ("`stella serve` fits *Oxagen-hosted* agents and does
not cover *developer-workstation* agents"). Both transports are expected to
coexist permanently, not to converge.

**Give every custom agent its own named adapter, the way Codex got one.**
Rejected. An adapter is worth writing only when Oxagen can parse and write
that agent's own settings file, the way it does for Claude Code, Codex, and
now Stella. An agent Oxagen has never seen has no such file to write, so the
only mechanism that scales to an unbounded set of agents is one the agent
author calls itself.

## Consequences

- `packages/tacho/src/host/stella-writer.ts` is the TOML/JSON marker-block
  writer, parallel to `codex-writer.ts`; both are merged and stripped the
  same way on `enroll`, `reassign --harness`, and `unenroll`.
- `docs/specs/oxagen-desktop/spec.md` §6 documents the wrapper table with
  Stella as a third column and the custom-agent hook as its own subsection,
  rather than as a fourth harness column, because it is not harness-specific.
- `apps/docs/content/docs/cli/wrap-an-agent.mdx` is the operator-facing
  surface for both: the three-harness comparison and the full
  `tacho hook --agent` contract with worked examples.
- When `tacho-core` ships on `macanderson/stella`, this ADR's Decision 1
  and Decision 2 are superseded in place (not re-litigated): the settings
  writer retires, the harness label moves from a hook-answered
  `client_attested` session to a natively-emitted one, and the session-boundary
  and multi-session-chaining limits in Decision 2 close. The plan reference
  in Tacho's spec §10 (plan §PR 9) is where that cutover is tracked.
- No Atlas migration rides this ADR. `stella` and `custom` were already
  members of `tacho.sessions.runtime`'s CHECK constraint before this
  decision; only the `codex` migration
  (`20260914120000_tacho_sessions_runtime_codex`) was still open, and it
  shipped separately.
