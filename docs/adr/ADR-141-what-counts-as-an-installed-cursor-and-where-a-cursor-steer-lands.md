# ADR-141: What counts as an installed Cursor, and where a Cursor steer lands

Status: Accepted. The Cursor pid section amended on 2026-09-25 (#4322).

Date: 2026-09-22

Related: #3367, #3349, #3384, ADR-078, ADR-101, `packages/tacho/src/cli/deps.ts`,
`packages/tacho/src/cli/detect.ts`,
`packages/tacho/src/claude-code/cursor-adapter.ts`,
`packages/tacho/src/collector/hook-handler.ts`, #3989, #4322, ADR-172,
`packages/tacho/src/collector/daemon.ts`

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

### A Cursor session carries no harness pid

> **Amended 2026-09-25 (#4322).** The original section ended a Cursor session
> on the six-hour idle sweep and left open whether a pid could replace it.
> Mac accepted the idle bound for Cursor on 2026-09-25 and asked for it to be
> as short as is safe. The bound is now one hour. This section states the
> rule, the value, and why.

*Added 2026-09-25 (#3989).* The daemon seals a session within one sweep of
its harness process exiting, and an operator's `cancel` sends that process
`SIGTERM` (`collector/inbox.ts`). Codex and Stella hooks pass the harness pid
as `TACHO_HARNESS_PID`. A Cursor hook passes none. In Cursor 3.22.7 the only
code that runs a command hook is the agent-host daemon
(`extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs`,
`CliHooksExecutor.executeCommandScript`, which spawns `$SHELL -c`). The
extension starts that daemon detached, reuses one already listening on its
socket, and one executor tracks many conversations. A pid found by walking up
from the hook would therefore outlive every conversation it serves, and a
`cancel` of one conversation would stop them all. A Cursor session ends on
Cursor's own `sessionEnd`, or on the idle sweep, with ADR-159's twelve-hour
close behind it.

**The idle bound for a Cursor session is one hour** (`cursorIdleSessionMs` in
`packages/tacho/src/collector/daemon.ts`). A Cursor session that ends without
its `sessionEnd` stays open until then: Cursor quit or crashed mid-run, a
window closed while the agent worked, or a conversation left open. Every
other session with no pid keeps the six-hour bound (`idleSessionMs`).

A live Cursor session goes quiet only between hooks, and Cursor fires one
before and after every tool call, at each subagent's start and stop, after
each reply, and at the end of each turn. So the longest quiet stretch inside a
turn is one tool call or one reply. Cursor's hooks page states no limit on a
tool call. Cursor's forum reports that the agent's shell tool gives up on a
foreground command after about ten minutes, and that a longer wait set by
the agent has held a fifteen-minute command (forum.cursor.com, "Timeout
setting on terminal/shell Agent tool"). One hour is four times the longer
figure.

A shorter bound costs this. A session quiet for longer than the bound is
sealed `crashed` at its last hook. That covers a person away between turns
for more than an hour, a laptop asleep for more than an hour, and a single
tool call that runs longer. The session's next hook reopens the chain with a
`reopen` start, and the control plane reopens the run (ADR-172), so nothing
recorded is lost. An operator message still queued on the session expires at
the seal, and the run reads as ended until the next hook arrives.

Oxagen does not look for a pid by another route. Which process runs a
`cursor-agent` CLI hook was never checked, because the check needs a Cursor
login. Customers never supply Oxagen a Cursor key, so no part of this design
may rest on one, and the idle bound needs none.

**Rejected: pass the daemon's pid for liveness only.** The daemon can be
stopped and started again while its conversations continue, so its exit is
not a conversation's end either.

**Rejected: a liveness-only key from the Cursor editor's main process.**
Cursor might pass the agent-host daemon a variable naming its main process,
but confirming that needs the editor on a real machine, and the key needs a
second registry field beside `record.pid`, because `cancel` signals
`record.pid`. A daemon that survives a Cursor restart would also carry a
stale main-process pid. The one-hour bound needs none of that, and a false
close repairs itself on the next hook.

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
