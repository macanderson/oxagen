# ADR-141: What counts as an installed Cursor, and where a Cursor steer lands

Status: Accepted

Date: 2026-09-22

Related: #3367, #3349, #3384, ADR-078, ADR-101, `packages/tacho/src/cli/deps.ts`,
`packages/tacho/src/cli/detect.ts`,
`packages/tacho/src/claude-code/cursor-adapter.ts`,
`packages/tacho/src/collector/hook-handler.ts`

## Context

ADR-101 made Cursor one of four first-class harnesses and wrapped it through
`~/.cursor/hooks.json`. Three questions it left open reached #3367 as residue,
and each one is a place where the product claims something the machine does not
do.

**An operator can steer a running Cursor session and nothing arrives.** The
dispatcher accepts a `message` or a `steer` and answers `next_step`.
`applyToSession` queues the text, and `deliversMessages`
(`packages/tacho/src/collector/hook-handler.ts:215`) drains it at `SessionStart`
alone, because Cursor's `beforeSubmitPrompt` answer carries `continue` and a
`user_message` the person reads, with nowhere to put text the agent reads. An
uninterrupted session therefore holds the command until it expires. The
operator was told it landed.

**A machine with the Cursor editor and no CLI reads as not installed.**
`cursorFacts` probed the `cursor-agent` alias alone. #3384's finding 18 had just
removed the generic `agent` fallback from that probe, correctly: an unrelated
executable named `agent` that printed a semver was being recorded as Cursor in
`host.json`. Removing it left the editor with no signal at all, and the desktop
wizard disables a row the probe calls absent. The editor reads the same hooks
file, so that machine is a supported install reported as absent.

**Both harness bridges are POSIX symlinks.** `.agents/skills` points at
`.claude/skills` for Codex and `.cursor/commands` points at `.claude/commands`
for Cursor. Git writes an ordinary text file for each on a checkout with
`core.symlinks=false`, which is the default on Windows without Developer Mode.
Codex then finds no skills and Cursor finds no commands, and nothing in either
failure names a symlink.

## Decision

### A Cursor steer lands at `stop`, as a follow-up message

Cursor's `stop` hook answers a `followup_message`, and Cursor submits it as the
next message in the conversation. It fires at the end of every turn, so it is
recurring, and it reaches the agent rather than the person. That is the
boundary a steer needs.

`cursorAnswer` already carries it: Claude Code's `decision: "block"` with a
`reason` on `Stop` means "keep going, because this", and the adapter writes that
out as `{"followup_message": "<reason>"}`
(`packages/tacho/src/claude-code/cursor-adapter.ts:306`, test "turns a blocked
stop into a follow-up message, and passes an empty answer through"). The queue
drain is what has to reach it: `deliversMessages` must return true for Cursor at
`Stop`, and the `Stop` case must answer with the drained text.

A `next_step` request degrades to `turn_boundary` on Cursor and the
`oxagen:command_applied` frame records the degradation, the way an `interrupt`
already degrades to `next_step` (`packages/tacho/src/wire.ts:349`). Cursor's
`preToolUse` answer is a permission object with no field for prose, so there is
no earlier boundary to reach, and a mode that says `turn_boundary` when that is
what happened is a true record.

**Rejected: refuse the delivery mode for Cursor.** It is the other half of the
issue's definition of done, and it is truthful, but it leaves an operator with
no way to redirect a running Cursor agent while a mechanism for it sits in the
adapter. A control plane that governs a harness has to be able to steer it.

**Rejected: register `beforeShellExecution` and `beforeMCPExecution` as well.**
They honour an `ask`, which would also settle the ask degradation, but they fire
for tool types `preToolUse` already covers, so every shell call would record two
frames and the trace oracles would read the second as a replay.

### An installed Cursor is the alias or the editor, and neither is not absence

Two signals, reported apart:

1. The `cursor-agent` alias on PATH. It is the only executable name trusted,
   it carries a version, and `enroll` records it as `cursor_execpath` and
   `cursor_version`.
2. The Cursor editor on disk, at the locations a platform documents:
   `/Applications/Cursor.app` and `~/Applications/Cursor.app` on macOS,
   `%LOCALAPPDATA%\Programs\cursor` and `%PROGRAMFILES%\Cursor` on Windows.

The editor lands under `CursorFacts.app`, never in `path`, so an application
directory cannot reach a field that means "the binary we would run".
`DetectedHarness.foundVia` says which probe answered.

Linux is left unprobed on purpose. Cursor ships there as an AppImage the person
places where they like, and a probe that names the wrong directory is worse than
one that says it does not know. Instead, the Cursor entry carries
`coverableWhenAbsent`, the counterpart of `unavailableReason`: enrollment writes
`~/.cursor/hooks.json` and that file governs the editor and the CLI alike, so a
surface offers the row with the reason rather than disabling it. `tacho detect`
prints the same sentence.

**Rejected: treat `~/.cursor` on disk as a third signal.** `tacho enroll
--harness cursor` creates that directory itself, so after one enrollment the
signal is answering its own question.

**Rejected: restore the generic `agent` name behind a version-string check.**
The check would rest on another program's version output, which is the
assumption that produced the wrong `host.json` in the first place.

### A bridge is committed as a symlink and materialized on checkout

The symlinks stay the committed form, because they are the one form that keeps
a single source of truth for `.claude/`. A repository bootstrap materializes
them where Git could not: on a checkout that wrote a bridge as a text file, it
replaces the file with a directory junction on Windows and a symlink elsewhere,
and it does nothing when the bridge already resolves. A check fails the build
when a bridge resolves to neither, so the failure names itself instead of
looking like a repository with no skills.

**Rejected: commit each bridge as a real directory with copied content.** Two
copies of every skill drift, and the drift is silent.

**Rejected: document `git config core.symlinks true` and stop there.** It needs
Developer Mode or an administrator on Windows, and a contributor who does not
run it gets the silent failure this decision exists to remove.

## Consequences

- Cursor's steer path is a real delivery with a recorded degradation rather
  than a promise the session never keeps. The change lands in
  `hook-handler.ts`, which owns the drain predicate and the `Stop` answer. The
  adapter half is in the tree and tested.
- `tacho detect`, `tacho enroll` and the desktop wizard can tell a machine with
  the editor from a machine with neither, and can offer Cursor on a Linux host
  they cannot probe. The desktop app reads `foundVia` and `coverableWhenAbsent`
  to enable the row.
- A Windows contributor gets both bridges or a build failure naming them, and
  the repository keeps one copy of every skill and command.
