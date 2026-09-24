# `@oxagen/steering-freshness`

Is this checkout running on the records that are in force?

A Context PR merges a record onto the repository's production branch
(ADR-061; `docs/specs/steering/README.md`). A developer on a feature branch
keeps whatever `.oxagen/` their branch point had, so the longer the branch
lives the more likely their agent is steering on records nobody uses any
more. This package answers that question, decides what to do about it, and
renders the answer for whichever agent is asking.

It depends on git and `zod`, and on nothing else. Oxagen governs whatever
agent a team already runs, so the one thing this must never grow is a
dependency on a particular harness.

## Boundary

- **Owns:** the freshness verdict for a checkout's `.oxagen/` directory, the
  `steering` settings block and how its four scopes combine, the sync that
  takes merged records from the production branch, the gate decision, the
  per-harness renderers, and installing the gate hook into each harness's
  config.
- **Does not own:** the `oxagen steering` command and its flags
  ([`apps/cli`](../../apps/cli/README.md), `apps/cli/src/commands/steering.ts`);
  the platform signal (steering version and published commits), which the CLI
  fetches and passes in; what the records say or how they reach a run
  ([`@oxagen/steering-assembler`](../steering-assembler/README.md)).
- **Depends on:** No `@oxagen/*` runtime dependencies. Its one runtime
  dependency is `zod`, and it shells out to `git`.
- **Used by:** `apps/cli` (`src/commands/steering.ts`).

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `GitRunner` | port | `packages/steering-freshness/src/git.ts` | `execGit` is the default; tests inject a fake |
| `PlatformSignal` | port | `packages/steering-freshness/src/check.ts` | `apps/cli/src/commands/steering.ts` supplies it from the platform |
| `HARNESS_RENDERERS` / `renderGate` | registry | `packages/steering-freshness/src/render.ts` | `apps/cli/src/commands/steering.ts` (`--harness`) |
| `installHook` / `removeHook` / `hookStatus` over `INSTALLABLE` | boundary | `packages/steering-freshness/src/hooks.ts` | `apps/cli/src/commands/steering.ts`. It writes `.claude/settings.json`, `$CODEX_HOME/hooks.json`, `~/.cursor/hooks.json`, and `$STELLA_HOME/stella.toml` |
| Exit code contract (`0` runs, `2` refuses) | boundary | `packages/steering-freshness/src/render.ts` | Each harness's prompt-submit hook |

## Entry points

- `.` → `src/index.ts`: `checkSteeringFreshness`, `evaluateGate`,
  `syncSteering`, `resolveSteeringPolicy`, the settings loaders, the renderers,
  the hook installer, and `execGit`.

## Rules

- Every failure resolves to `unknown`, and `unknown` never blocks a run.
- A later settings scope may switch a gate on and may never switch it off.
- A new harness is an alias and a renderer, never a second copy of the
  decision (ADR-101 names the four harnesses).
- The package takes no dependency on a particular harness.

## Tests

```bash
pnpm --filter @oxagen/steering-freshness test:unit src/check.test.ts
```

Never put `--` before the filename. Each module has a `src/<module>.test.ts`
beside it, and `src/integration.test.ts` drives the modules together.

## The verdict

`checkSteeringFreshness` compares the checkout against the remote production
branch and answers one of five statuses.

| Status     | What it means                                                            | Blocks a run |
| ---------- | ------------------------------------------------------------------------ | ------------ |
| `current`  | Nothing merged here that this checkout lacks.                            | no           |
| `ahead`    | Only this checkout changed `.oxagen/`. Authoring, not staleness.         | no           |
| `behind`   | Records merged on the production branch that this checkout lacks.        | yes          |
| `diverged` | Behind, and this checkout changed `.oxagen/` too. A sync needs a person. | yes          |
| `unknown`  | The question could not be answered.                                      | never        |

### Why the merge base, not a directory comparison

The obvious implementation compares the two `.oxagen/` trees and calls any
difference staleness. It is wrong in the case that matters most: a developer
authoring a record has a `.oxagen/` that differs from main *because they are
writing the next record*, and a check that cannot tell that apart from "main
moved" would block the very work the system exists to encourage, every time,
until it was turned off.

Git already separates the two. From the merge base of HEAD and the remote
production branch, changes on the remote side are records that merged without
this checkout, and changes on the local side are records being authored here.
Only the first is staleness.

Both lists are then narrowed to the paths whose *working copy* differs from
the production branch, because the question is about the file the agent will
read and not about which commit it arrived in. Without that, a sync would
stage the files, HEAD would not move, and the gate would refuse a prompt over
records it had written to disk a moment earlier.

### Why it fails open

Every failure path resolves to `unknown`, which never blocks: no repository,
no remote, no merge base, an unreachable network, a git that is not
installed. A governance control that stops all work whenever its own plumbing
hiccups does not get to stay switched on, and a gate that is switched off
protects nothing.

## The two gates

```jsonc
// .oxagen/settings.json
{
  "steering": {
    "autoSync": false,          // take the merged records before the prompt runs
    "blockStaleRuns": false,    // refuse the prompt while records are missing
    "remote": "origin",
    "branch": null,             // null resolves the remote's default branch
    "fetchIntervalSeconds": 300,
    "exclude": []
  }
}
```

Four scopes, lowest first: `~/.config/oxagen/settings.json`, the project's
`.oxagen/settings.json`, the personal `.oxagen/settings.local.json`, and the
workspace policy from Oxagen.

**The two booleans combine with OR, not with overwrite.** A later scope may
switch a gate ON and may never switch one OFF. The point of
`blockStaleRuns` is that an organisation can insist its agents run on records
that are in force, and a personal file that could set it back to `false`
would make the setting decorative.

The project file is read from the working copy and from the production
branch as last fetched (`loadCommittedProjectGates`). An uncommitted edit to
`.oxagen/settings.json` therefore cannot switch off a gate the team
committed. Which ref that second read uses is chosen by the workspace, or by
the remote's own default branch, never by the file being audited. The gate
reads it once more after its own fetch, since the fetch is what publishes a
newly committed gate to that ref.

`OXAGEN_STEERING_FRESHNESS=off` suspends both for one shell. A gate with no
way out is a gate that gets uninstalled the first time a remote is
unreachable at 3am.

## Reaching a harness

`oxagen steering gate` is the entry point, and the contract is the one every
shell already understands:

- exit `0` — the prompt may run. A warning still exits 0.
- exit `2` — the prompt is refused, with the reason on stderr.
- stdout — the harness's own JSON, chosen by `--harness`.

`renderGate` picks a renderer by name. Claude Code and Codex CLI share one:
both fire a `UserPromptSubmit` hook that reads JSON from the hook's stdout,
and the blocking payload carries Claude Code's
`hookSpecificOutput.permissionDecision`, Codex's top-level `decision`, and
exit 2, all at once. Each harness reads the keys it knows, they cannot
disagree because they are rendered from one decision, and a harness that
reads neither still sees the exit code.

A harness this build has never heard of falls back to the text renderer.
Adding first-class support for a new agent is an entry in the alias table and
a renderer, never a second copy of the decision.

## Layout

| File           | What it owns                                                     |
| -------------- | ---------------------------------------------------------------- |
| `git.ts`       | The only place this package shells out. An injectable runner.     |
| `check.ts`     | The verdict.                                                      |
| `policy.ts`    | The `steering` block and how the scopes combine.                  |
| `settings.ts`  | Reading that block off disk.                                      |
| `cache.ts`     | The fetch throttle, stamped in git's own directory.               |
| `sync.ts`      | Taking `.oxagen/` from the production branch, and what it refuses.|
| `gate.ts`      | One decision, made once, for every harness.                       |
| `render.ts`    | Turning that decision into whatever a harness understands.        |
| `hooks.ts`     | Installing the gate into a harness's config, without clobbering.  |
