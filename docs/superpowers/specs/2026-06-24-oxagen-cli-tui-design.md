# Oxagen CLI — interactive TUI (banner + menu launcher + arg forms)

**Date:** 2026-06-24
**Status:** Approved design — ready for implementation plan
**Area:** `apps/cli`
**Branch:** `feat/cli-dev-binary-and-daemon-adr` (worktree `../oxagen-cli-dev`)

## Problem & goal

Running bare `oxagen` today prints static Commander help. We want a polished
**interactive terminal UI**, similar in spirit to Claude Code's launch experience:

1. An **ASCII-art welcome banner** (Oxagen wordmark in the brand palette) on launch.
2. A **menu-launcher TUI** the user navigates with the keyboard: browse the 34 command
   groups and 134 commands, drill into a command, and **run it via interactive argument
   prompts**, all without leaving the TUI.

The TUI must be **additive and non-breaking**: every existing invocation
(`oxagen <group> <cmd> --flags`, piped/CI usage, `--help`, scripts) behaves exactly as it
does today. Only bare, interactive `oxagen` changes.

## Non-goals (v1)

- Fuzzy global command search across all 134 commands (v1 has simple type-to-filter within
  the current list only).
- Persisted recents/favorites, command history.
- Multiple themes / configurable palette.
- Per-command bespoke widgets (everything is generated from Commander metadata in v1).
- Replacing the `oxagen dev` status TUI (it stays; it only shares the new `theme.ts`).

## Decisions captured from brainstorming

- **Navigation model:** menu launcher (banner + arrow-key menu; `Enter` drills in, `Esc`
  goes back, breadcrumbs).
- **Leaf-command behavior:** interactive argument prompts — selecting a command opens a form
  for its args/flags, then executes and shows output.

## Architecture

New module **`apps/cli/src/tui/`**, isolated from the 134 command files. Each unit has one
purpose, a clear interface, and is independently testable.

| Unit | Responsibility | Interface (shape) | Depends on |
|------|----------------|-------------------|------------|
| `theme.ts` | Single source of truth for brand palette + glyphs, extracted from `DevStatus.tsx`. | `export const theme = { cyan: "#7CE8F4", violet: "#7C5AED", ring: "◯", … }` | — |
| `banner.tsx` | Renders the ASCII-art `OXAGEN` wordmark + `◯` ring + `developer CLI vX.Y.Z` tagline. | `<Banner version={string} />` | `theme` |
| `command-tree.ts` | **Pure** introspection of the Commander `program` into a serializable tree. No Ink. | `buildCommandTree(program: Command): CommandNode` where `CommandNode = { name, description, path: string[], args: ArgSpec[], options: OptSpec[], children: CommandNode[], runnable: boolean }` | `commander` |
| `command-form.tsx` | Generic form generated from a `CommandNode`'s `args`+`options`. Text fields, boolean toggles, required-field validation, masked input for secret-ish flags. Emits assembled tokens on submit. | `<CommandForm node={CommandNode} onSubmit={(argv: string[]) => void} onCancel={() => void} />` | `@inkjs/ui`, `theme` |
| `runner.ts` | Given a `CommandNode` + assembled `argv`, execute the real command. | `runCommand(program, node, argv): Promise<{ code: number }>` | `commander` program |
| `app.tsx` | Root Ink component. Navigation **state machine** + key handling + type-to-filter. Owns screen transitions. | `<App program={Command} version={string} />`; `export function launchTui(program, version): Promise<void>` | all above + `ink` |

### Metadata extraction (`ArgSpec` / `OptSpec`)

`command-tree.ts` reads Commander's public structure:

- `command.commands` → `children` (recursive). A node is `runnable` when it has its own
  `.action()` handler / no further subcommands.
- `command.registeredArguments` → `ArgSpec { name, required, description, variadic }`.
- `command.options` → `OptSpec { flags, long, short, description, required, isBoolean,
  takesValue, defaultValue, mandatory, choices? }` (derived from each `Option`:
  `option.required`/`option.mandatory`, `option.isBoolean()`, `option.flags`).
- Secret masking: an option is masked when its long flag matches
  `/(password|secret|token|api[-_]?key|auth[-_]?config)/i`.

This means **the menu and every form are generated**; adding a command in `index.tsx`
surfaces it in the TUI with zero TUI changes.

## Data flow / state machine

```
                       ┌──────────── q / Ctrl-C: exit ───────────┐
launchTui(program)     │                                         ▼
   │ build tree     ┌──────┐  Enter   ┌──────────┐  Enter  ┌──────────┐  submit  ┌──────────┐
   └──────────────► │ menu │ ───────► │ commands │ ──────► │  form    │ ───────► │ running  │
                    │ (grp)│ ◄─────── │ (in grp) │ ◄────── │ (args)   │          │ (exec)   │
                    └──────┘   Esc    └──────────┘   Esc   └──────────┘          └────┬─────┘
                       ▲                                                              │ done
                       └───────────────────── Esc (back to menu) ◄────── ┌──────────┐│
                                                                          │  result  │◄┘
                                                                          └──────────┘
```

- **Screens:** `menu` (top-level groups) → `commands` (children of a group; groups can nest,
  so this is the same recursive screen advancing the breadcrumb) → `form` → `running` →
  `result`.
- **Keys:** `↑/↓` move, `Enter` select/drill, `Esc` back (or quit from the root), `q`/`Ctrl-C`
  quit. Typing characters filters the current list (substring, case-insensitive); `Backspace`
  edits the filter.
- **Breadcrumb:** `oxagen › agent › mcp › register` shown under the banner.

### Execution model (`runner.ts`)

On form submit:

1. `app.tsx` calls `app.unmount()` (from Ink's `render()` result) so the terminal is handed
   back cleanly.
2. `runner.runCommand` invokes the real command in-process:
   `await program.parseAsync([...node.path, ...argv], { from: "user" })`. Full Commander
   parsing, auth (`requireAuth`), config, and any streaming output behave exactly as a normal
   `oxagen <cmd>` invocation, writing to real stdout/stderr.
3. On completion the process prints a `↵ back to menu · q quit` footer and **re-mounts**
   `<App>` at the `result`/`menu` screen. (Re-mount keeps a single long-lived process.)
4. Commander is configured with `exitOverride()` for the TUI path so a command's
   `process.exit()`/parse error is caught and surfaced in the `result` screen instead of
   killing the TUI.

> Rationale for in-process over child-process spawn: the commands already live in this
> process and share `lib/config.ts` + `lib/api-client.ts`; re-parsing argv reuses all of it
> with correct stdio, and avoids serializing args through a shell.

## Activation (the non-breaking seam)

In `apps/cli/src/index.tsx`, **before** `program.parse(process.argv)`:

```ts
const noCommand = process.argv.slice(2).length === 0;
const wantsTui = noCommand && process.stdout.isTTY && !process.env.OXAGEN_NO_TUI;
if (wantsTui) {
  const { launchTui } = await import("./tui/app.js"); // lazy: Ink not loaded otherwise
  await launchTui(program, version);
} else {
  program.parse(process.argv);
}
```

- `--help` / `--version` are flags (argv length > 0) → normal Commander path.
- Non-TTY (pipe, CI, redirect) → normal path (prints help), so scripts and `oxagen | cat`
  are unaffected.
- `OXAGEN_NO_TUI=1` escape hatch for users who want the old bare-help behavior.
- Ink loads only on the TUI path (lazy import), so the 134 normal commands keep their fast
  startup.

## Dependencies

- **Add `@inkjs/ui`** (the Ink author's component kit: `Select`, `TextInput`, masked input,
  `Spinner`) to `apps/cli/package.json`. Reduces hand-rolled input/list code and is
  maintained against current Ink. Pin an exact version (repo convention). Run
  `pnpm i --no-frozen-lockfile`.
- Already present: `ink@7.1.0`, `react@19.2.6`, `commander@12.1.0`.

## Theme refactor (targeted, in-scope)

`DevStatus.tsx` currently hardcodes the palette (`#7CE8F4`, `#7C5AED`). Extract these into
`tui/theme.ts` and import from both `banner.tsx` and `DevStatus.tsx` so there is one
definition of the Oxagen brand colors. No behavior change to `oxagen dev`.

## Error handling

- **Required-field validation:** form blocks submit and highlights missing required
  args/options; shows the message under the field.
- **Command execution failure:** caught via `exitOverride()`; the `result` screen shows the
  exit code + captured stderr tail; `Esc` returns to the menu (TUI never crashes on a failing
  command).
- **Resize:** Ink re-renders on terminal resize; layouts use flex (`<Box>`), no fixed widths
  that overflow narrow terminals; banner degrades to a compact one-line wordmark below a
  min width.
- **Non-TTY safety:** TUI never launches without a TTY, so no raw-mode errors in CI.

## Testing strategy

The package uses Vitest with a coverage gate; new TUI code ships with tests.

- **Unit (`command-tree.test.ts`):** build a fixture Commander program (nested groups, args,
  required/optional/boolean options, a secret flag) → assert the produced `CommandNode` tree:
  child structure, `runnable`, `ArgSpec`/`OptSpec` fields, secret-mask detection.
- **Unit (`runner.test.ts`):** assert argv assembly from form values (booleans → `--flag`
  only when true; values → `--flag value`; positional args ordered; omitted optionals
  excluded) and that `parseAsync` is called with the right tokens (program mocked).
- **Component (`ink-testing-library`):**
  - `banner.test.tsx` — renders wordmark + version.
  - `app.test.tsx` — render `<App>`, simulate `↓`/`Enter`/`Esc`, assert breadcrumb + visible
    list transitions (menu → commands → form); type-to-filter narrows the list.
  - `command-form.test.tsx` — simulate input into fields, submit, assert emitted argv;
    required-field validation blocks submit; secret field renders masked.
- **No Playwright e2e:** a terminal TUI's integration layer is `ink-testing-library`; that is
  the e2e-equivalent proof here (CLAUDE.md's Playwright e2e parity targets `apps/app` web
  flows). Capture a rendered-frame snapshot from `ink-testing-library` as the visible proof.

## File-change summary

```
apps/cli/
  package.json                     (+ @inkjs/ui)
  src/
    index.tsx                      (activation seam; lazy import launchTui)
    components/DevStatus.tsx        (import palette from tui/theme)
    tui/
      theme.ts                     (new)
      banner.tsx                   (new)
      command-tree.ts              (new)
      command-form.tsx             (new)
      runner.ts                    (new)
      app.tsx                      (new)
      __tests__/
        command-tree.test.ts       (new)
        runner.test.ts             (new)
        banner.test.tsx            (new)
        app.test.tsx               (new)
        command-form.test.tsx      (new)
README / apps/cli/README.md        (document the interactive TUI + OXAGEN_NO_TUI)
```

## Rollout

- Lands on `feat/cli-dev-binary-and-daemon-adr` (depends on its ink-7 upgrade + lazy-load),
  folding into PR #156 — or a stacked PR if preferred.
- Verified by: `pnpm cli:dev` then run bare `oxagen` to see the banner + menu; navigate to a
  command, submit a form, see it execute; `OXAGEN_NO_TUI=1 oxagen` and `oxagen --help` show
  the old behavior; component-test rendered frame captured as proof.

## Open questions (none blocking)

- Exact `@inkjs/ui` version to pin — resolve at implementation against ink 7 peer range.
- Whether streaming commands (`chat send`, `conversation chat`) should stay unmounted until
  the user presses a key vs auto-return — default: auto-return to `result` on stream end;
  revisit if it feels abrupt.
