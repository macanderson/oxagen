---
title: "Oxagen CLI TUI"
description: "Archived spec & plan — status: partially shipped (audited 2026-07-03)."
---

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The interactive TUI was fully implemented in PR #165 (commit 3d450ece) with menu launcher, command-form component, arg introspection, state machine, and activation seam. However, all 8 core files were deleted in checkpoint commit 6239d4e1 (775 line deletion). Currently only theme.ts and banner.tsx remain in extended form; command-tree.ts, runner.ts, command-form.tsx, app.tsx, the activation seam, and @inkjs/ui dependency are completely missing. README still documents the feature despite its removal from code.

**Implementation evidence**

- Commit 3d450ece 'feat(cli): interactive TUI — ASCII banner + menu launcher + argument forms (#165)' fully implemented all components
- Commit 6239d4e1 'checkpoint' deleted 8 files: command-tree.ts, runner.ts, command-form.tsx, app.tsx, command-tree.test.ts, runner.test.ts, command-form.test.tsx, app.test.tsx
- apps/cli/src/tui/theme.ts exists and is extended with additional color palette
- apps/cli/src/tui/banner.tsx exists and is extended with animate parameter beyond spec
- apps/cli/src/tui/command-tree.ts does not exist (deleted in checkpoint)
- apps/cli/src/tui/runner.ts does not exist (deleted in checkpoint)
- apps/cli/src/tui/command-form.tsx does not exist (deleted in checkpoint)
- apps/cli/src/tui/app.tsx does not exist (deleted in checkpoint)
- apps/cli/src/index.tsx has only program.parseAsync() with no activation seam
- apps/cli/package.json has no @inkjs/ui dependency
- apps/cli/README.md documents interactive TUI feature (lines 26-36) but implementation is gone

**Known gaps at time of archive**

- command-tree.ts - pure Commander introspection (buildCommandTree, ArgSpec, OptSpec interfaces)
- runner.ts - argv assembly and child-process execution (assembleArgv, runCommand)
- command-form.tsx - interactive form component for command arguments
- app.tsx - navigation state machine and launchTui export
- Activation seam in index.tsx - conditional TTY detection and lazy-load logic
- @inkjs/ui@2.0.0 dependency for form UI components (TextInput, PasswordInput, Spinner)
- All 4 test files for deleted components (command-tree.test.ts, runner.test.ts, command-form.test.tsx, app.test.tsx)

**Source documents** (archived verbatim below)

- `docs/superpowers/specs/2026-06-24-oxagen-cli-tui-design.md`
- `docs/superpowers/plans/2026-06-24-oxagen-cli-tui.md`

## Spec — `2026-06-24-oxagen-cli-tui-design.md`

## Oxagen CLI — interactive TUI (banner + menu launcher + arg forms)

**Date:** 2026-06-24
**Status:** Approved design — ready for implementation plan
**Area:** `apps/cli`
**Branch:** `feat/cli-dev-binary-and-daemon-adr` (worktree `../oxagen-cli-dev`)

### Problem & goal

Running bare `oxagen` today prints static Commander help. We want a polished
**interactive terminal UI**, similar in spirit to Claude Code's launch experience:

1. An **ASCII-art welcome banner** (Oxagen wordmark in the brand palette) on launch.
2. A **menu-launcher TUI** the user navigates with the keyboard: browse the 34 command
   groups and 134 commands, drill into a command, and **run it via interactive argument
   prompts**, all without leaving the TUI.

The TUI must be **additive and non-breaking**: every existing invocation
(`oxagen <group> <cmd> --flags`, piped/CI usage, `--help`, scripts) behaves exactly as it
does today. Only bare, interactive `oxagen` changes.

### Non-goals (v1)

- Fuzzy global command search across all 134 commands (v1 has simple type-to-filter within
  the current list only).
- Persisted recents/favorites, command history.
- Multiple themes / configurable palette.
- Per-command bespoke widgets (everything is generated from Commander metadata in v1).
- Replacing the `oxagen dev` status TUI (it stays; it only shares the new `theme.ts`).

### Decisions captured from brainstorming

- **Navigation model:** menu launcher (banner + arrow-key menu; `Enter` drills in, `Esc`
  goes back, breadcrumbs).
- **Leaf-command behavior:** interactive argument prompts — selecting a command opens a form
  for its args/flags, then executes and shows output.

### Architecture

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

#### Metadata extraction (`ArgSpec` / `OptSpec`)

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

### Data flow / state machine

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

#### Execution model (`runner.ts`)

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

### Activation (the non-breaking seam)

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

### Dependencies

- **Add `@inkjs/ui`** (the Ink author's component kit: `Select`, `TextInput`, masked input,
  `Spinner`) to `apps/cli/package.json`. Reduces hand-rolled input/list code and is
  maintained against current Ink. Pin an exact version (repo convention). Run
  `pnpm i --no-frozen-lockfile`.
- Already present: `ink@7.1.0`, `react@19.2.6`, `commander@12.1.0`.

### Theme refactor (targeted, in-scope)

`DevStatus.tsx` currently hardcodes the palette (`#7CE8F4`, `#7C5AED`). Extract these into
`tui/theme.ts` and import from both `banner.tsx` and `DevStatus.tsx` so there is one
definition of the Oxagen brand colors. No behavior change to `oxagen dev`.

### Error handling

- **Required-field validation:** form blocks submit and highlights missing required
  args/options; shows the message under the field.
- **Command execution failure:** caught via `exitOverride()`; the `result` screen shows the
  exit code + captured stderr tail; `Esc` returns to the menu (TUI never crashes on a failing
  command).
- **Resize:** Ink re-renders on terminal resize; layouts use flex (`<Box>`), no fixed widths
  that overflow narrow terminals; banner degrades to a compact one-line wordmark below a
  min width.
- **Non-TTY safety:** TUI never launches without a TTY, so no raw-mode errors in CI.

### Testing strategy

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

### File-change summary

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

### Rollout

- Lands on `feat/cli-dev-binary-and-daemon-adr` (depends on its ink-7 upgrade + lazy-load),
  folding into PR #156 — or a stacked PR if preferred.
- Verified by: `pnpm cli:dev` then run bare `oxagen` to see the banner + menu; navigate to a
  command, submit a form, see it execute; `OXAGEN_NO_TUI=1 oxagen` and `oxagen --help` show
  the old behavior; component-test rendered frame captured as proof.

### Open questions (none blocking)

- Exact `@inkjs/ui` version to pin — resolve at implementation against ink 7 peer range.
- Whether streaming commands (`chat send`, `conversation chat`) should stay unmounted until
  the user presses a key vs auto-return — default: auto-return to `result` on stream end;
  revisit if it feels abrupt.

## Document — `2026-06-24-oxagen-cli-tui.md`

## Oxagen CLI Interactive TUI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bare interactive `oxagen` launch an ASCII-banner TUI that lets users navigate the Commander command tree and run any command via interactive argument prompts, without breaking any existing non-interactive usage.

**Architecture:** A new `apps/cli/src/tui/` module. A pure introspector turns the Commander `program` into a serializable tree; a generic Ink form is generated from each command's args/options; an Ink state-machine component (`app.tsx`) drives menu → command → form → run navigation; a runner spawns the real CLI as a child process to execute the assembled argv. An activation seam in `index.tsx` launches the TUI only for bare, interactive (TTY) invocations.

**Tech Stack:** TypeScript 6, Commander 12, Ink 7 + React 19, `@inkjs/ui` (TextInput/PasswordInput/Spinner), `ink-testing-library` + Vitest.

### Global Constraints

- TypeScript `6.0.3`, no `any`. Turbopack/ESM: import with `.js` specifiers (e.g. `"./theme.js"`), extensionless for tsx/ts is wrong here — this package compiles with `tsc`, so use `.js` specifiers as the rest of `apps/cli/src` does.
- `type: "module"` ESM. JSON imports use `import x from "./f.json" with { type: "json" }` and read the default export.
- Pin exact dependency versions (repo convention): `@inkjs/ui` = `2.0.0`, `ink-testing-library` = `4.0.0`. Add to `apps/cli/package.json` only; run `pnpm i --no-frozen-lockfile`.
- ESLint zero-warnings gate; no `eslint-disable` without an inline reason. The package's Vitest coverage thresholds must not regress — every new file ships with tests in the same task.
- **NEVER run the whole suite.** Run only the specific test file(s) for the task, e.g. `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/command-tree.test.ts`.
- Branch: work in the existing worktree `../oxagen-cli-dev` on `feat/cli-dev-binary-and-daemon-adr`. Commit after each task; push regularly.
- Do not modify the 134 command files or change any existing command's behavior. The only edit to existing code outside `tui/` is the activation seam in `index.tsx` and the palette import in `components/DevStatus.tsx`.

---

#### Task 1: `theme.ts` — single source of truth for the brand palette

**Files:**
- Create: `apps/cli/src/tui/theme.ts`
- Modify: `apps/cli/src/components/DevStatus.tsx` (replace hardcoded hex with theme imports)
- Test: `apps/cli/src/tui/__tests__/theme.test.ts`

**Interfaces:**
- Produces: `export const theme = { cyan, violet, dim, ring, pointer } as const` — string constants consumed by `banner.tsx`, `command-form.tsx`, `app.tsx`, and `DevStatus.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/src/tui/__tests__/theme.test.ts
import { describe, it, expect } from "vitest";
import { theme } from "../theme.js";

describe("theme", () => {
  it("exposes the Oxagen brand palette and glyphs", () => {
    expect(theme.cyan).toBe("#7CE8F4");
    expect(theme.violet).toBe("#7C5AED");
    expect(theme.ring).toBe("◯");
    expect(theme.pointer).toBe("❯");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/theme.test.ts`
Expected: FAIL — cannot find module `../theme.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/cli/src/tui/theme.ts
// The Oxagen brand palette. Single source of truth shared by every TUI surface
// (banner, menu, forms) and the `oxagen dev` status view.
export const theme = {
  cyan: "#7CE8F4", // jewel cyan — ring glyph, accents
  violet: "#7C5AED", // jewel violet — wordmark, selection
  dim: "gray",
  ring: "◯",
  pointer: "❯",
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `DevStatus.tsx` to import the palette**

In `apps/cli/src/components/DevStatus.tsx`, add at the top with the other imports:

```tsx
import { theme } from "../tui/theme.js";
```

Replace the banner colors:
- `<Text color="#7CE8F4">◯ </Text>` → `<Text color={theme.cyan}>{theme.ring} </Text>`
- `<Text color="#7C5AED" bold>` → `<Text color={theme.violet} bold>`

- [ ] **Step 6: Verify the dev view still renders (typecheck + build)**

Run: `pnpm --filter @oxagen/cli typecheck && pnpm --filter @oxagen/cli build`
Expected: both succeed, no errors.

- [ ] **Step 7: Commit**

```bash
git -C ../oxagen-cli-dev add apps/cli/src/tui/theme.ts apps/cli/src/tui/__tests__/theme.test.ts apps/cli/src/components/DevStatus.tsx
git -C ../oxagen-cli-dev commit -m "feat(cli): add tui theme palette; DevStatus reuses it"
```

---

#### Task 2: `command-tree.ts` — pure Commander introspection

**Files:**
- Create: `apps/cli/src/tui/command-tree.ts`
- Test: `apps/cli/src/tui/__tests__/command-tree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ArgSpec { name: string; required: boolean; variadic: boolean; description: string }
  export interface OptSpec {
    flags: string; long: string; short?: string; description: string;
    required: boolean; isBoolean: boolean; takesValue: boolean;
    defaultValue?: unknown; secret: boolean; choices?: string[];
  }
  export interface CommandNode {
    name: string; description: string; path: string[];
    args: ArgSpec[]; options: OptSpec[]; children: CommandNode[]; runnable: boolean;
  }
  export function buildCommandTree(program: Command): CommandNode
  ```
- `path` is the argv path from the root, excluding the program name (e.g. `["agent","mcp","register"]`). The root node's `path` is `[]`.
- `runnable` is true when a node has no child commands.
- Consumed by `runner.ts` (`path`, `args`, `options`), `command-form.tsx` (`args`, `options`), `app.tsx` (`children`, `name`, `description`, `runnable`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/src/tui/__tests__/command-tree.test.ts
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { buildCommandTree } from "../command-tree.js";

function fixture(): Command {
  const program = new Command("oxagen").description("Oxagen developer CLI");
  const auth = program.command("auth").description("Authentication");
  auth
    .command("login")
    .description("Authenticate")
    .requiredOption("--email <email>", "Email address")
    .requiredOption("--password <password>", "Password")
    .option("--remember", "Stay signed in")
    .action(() => {});
  const agent = program.command("agent").description("Agent commands");
  const mcp = agent.command("mcp").description("MCP servers");
  mcp
    .command("register")
    .description("Register an MCP server")
    .argument("<name>", "server name")
    .option("--auth-config <json>", "auth config")
    .action(() => {});
  return program;
}

describe("buildCommandTree", () => {
  it("maps nested groups, args, options, and runnable leaves", () => {
    const tree = buildCommandTree(fixture());
    expect(tree.name).toBe("oxagen");
    expect(tree.path).toEqual([]);
    expect(tree.children.map((c) => c.name).sort()).toEqual(["agent", "auth"]);

    const login = tree.children.find((c) => c.name === "auth")!.children[0];
    expect(login.path).toEqual(["auth", "login"]);
    expect(login.runnable).toBe(true);
    expect(login.options.find((o) => o.long === "--email")!.required).toBe(true);
    expect(login.options.find((o) => o.long === "--remember")!.isBoolean).toBe(true);

    const register = tree.children
      .find((c) => c.name === "agent")!.children
      .find((c) => c.name === "mcp")!.children[0];
    expect(register.path).toEqual(["agent", "mcp", "register"]);
    expect(register.args[0]).toMatchObject({ name: "name", required: true, variadic: false });
    expect(register.options.find((o) => o.long === "--auth-config")!.secret).toBe(true);
  });

  it("omits the implicit help command", () => {
    const tree = buildCommandTree(fixture());
    expect(tree.children.some((c) => c.name === "help")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/command-tree.test.ts`
Expected: FAIL — cannot find module `../command-tree.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/cli/src/tui/command-tree.ts
import type { Argument, Command, Option } from "commander";

export interface ArgSpec {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
}

export interface OptSpec {
  flags: string;
  long: string;
  short?: string;
  description: string;
  required: boolean;
  isBoolean: boolean;
  takesValue: boolean;
  defaultValue?: unknown;
  secret: boolean;
  choices?: string[];
}

export interface CommandNode {
  name: string;
  description: string;
  path: string[];
  args: ArgSpec[];
  options: OptSpec[];
  children: CommandNode[];
  runnable: boolean;
}

// Flags whose values must never be shown in plaintext in the form.
const SECRET_RE = /(password|secret|token|api[-_]?key|auth[-_]?config)/i;

export function buildCommandTree(program: Command): CommandNode {
  return toNode(program, []);
}

function toNode(cmd: Command, path: string[]): CommandNode {
  const children = cmd.commands
    .filter((c) => c.name() !== "help")
    .map((c) => toNode(c, [...path, c.name()]));
  return {
    name: cmd.name(),
    description: cmd.description() ?? "",
    path,
    args: cmd.registeredArguments.map(toArgSpec),
    options: cmd.options.map(toOptSpec),
    children,
    runnable: children.length === 0,
  };
}

function toArgSpec(a: Argument): ArgSpec {
  return {
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    description: a.description ?? "",
  };
}

function toOptSpec(o: Option): OptSpec {
  const long = o.long ?? "";
  return {
    flags: o.flags,
    long,
    short: o.short ?? undefined,
    description: o.description ?? "",
    required: o.mandatory,
    isBoolean: o.isBoolean(),
    takesValue: !o.isBoolean(),
    defaultValue: o.defaultValue,
    secret: SECRET_RE.test(long),
    choices: o.argChoices,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/command-tree.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git -C ../oxagen-cli-dev add apps/cli/src/tui/command-tree.ts apps/cli/src/tui/__tests__/command-tree.test.ts
git -C ../oxagen-cli-dev commit -m "feat(cli): introspect commander program into a serializable command tree"
```

---

#### Task 3: `runner.ts` — argv assembly (pure) + child-process execution

**Files:**
- Create: `apps/cli/src/tui/runner.ts`
- Test: `apps/cli/src/tui/__tests__/runner.test.ts`

> **Execution model:** the runner spawns the real CLI entry as a child process
> (`process.execPath process.argv[1] <path...> <argv...>` with `stdio: "inherit"`),
> not in-process `parseAsync`. Same external behavior; repeat-safe across multiple
> runs in one TUI session and isolates a crashing command from the TUI. This refines
> the spec's "in-process" wording.

**Interfaces:**
- Consumes: `CommandNode`, `ArgSpec`, `OptSpec` from `./command-tree.js`.
- Produces:
  ```ts
  export type FormValues = Record<string, string | boolean>;
  export function assembleArgv(node: CommandNode, values: FormValues): string[]
  export function runCommand(node: CommandNode, argv: string[]): Promise<{ code: number }>
  ```
- Form value keys: positional args use `arg:<name>`; options use `opt:<long>` (e.g. `opt:--email`). `command-form.tsx` must use these exact keys.

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/src/tui/__tests__/runner.test.ts
import { describe, it, expect, vi } from "vitest";
import type { CommandNode } from "../command-tree.js";
import { assembleArgv } from "../runner.js";

const node: CommandNode = {
  name: "login",
  description: "Authenticate",
  path: ["auth", "login"],
  args: [{ name: "name", required: true, variadic: false, description: "" }],
  options: [
    { flags: "--email <e>", long: "--email", description: "", required: true, isBoolean: false, takesValue: true, secret: false },
    { flags: "--remember", long: "--remember", description: "", required: false, isBoolean: true, takesValue: false, secret: false },
    { flags: "--tags <t...>", long: "--tags", description: "", required: false, isBoolean: false, takesValue: true, secret: false },
  ],
  children: [],
  runnable: true,
};

describe("assembleArgv", () => {
  it("orders positionals, includes set options, and drops empty/false ones", () => {
    const argv = assembleArgv(node, {
      "arg:name": "acme",
      "opt:--email": "you@example.com",
      "opt:--remember": true,
    });
    expect(argv).toEqual(["acme", "--email", "you@example.com", "--remember"]);
  });

  it("omits boolean flags that are false and value options left blank", () => {
    const argv = assembleArgv(node, { "arg:name": "acme", "opt:--remember": false, "opt:--email": "" });
    expect(argv).toEqual(["acme"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/runner.test.ts`
Expected: FAIL — cannot find module `../runner.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/cli/src/tui/runner.ts
import { spawn } from "node:child_process";
import type { CommandNode } from "./command-tree.js";

export type FormValues = Record<string, string | boolean>;

// Build the argv tokens that follow the command path, from collected form values.
export function assembleArgv(node: CommandNode, values: FormValues): string[] {
  const tokens: string[] = [];

  for (const arg of node.args) {
    const v = values[`arg:${arg.name}`];
    if (typeof v === "string" && v.trim() !== "") {
      if (arg.variadic) tokens.push(...v.trim().split(/\s+/));
      else tokens.push(v);
    }
  }

  for (const opt of node.options) {
    const v = values[`opt:${opt.long}`];
    if (opt.isBoolean) {
      if (v === true) tokens.push(opt.long);
    } else if (typeof v === "string" && v.trim() !== "") {
      tokens.push(opt.long, v);
    }
  }

  return tokens;
}

// Execute the selected command as a child process so each run is isolated and
// repeat-safe. stdio is inherited so auth prompts and streaming output work.
export function runCommand(node: CommandNode, argv: string[]): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const entry = process.argv[1];
    const child = spawn(process.execPath, [entry, ...node.path, ...argv], { stdio: "inherit" });
    child.on("exit", (code) => resolve({ code: code ?? 0 }));
    child.on("error", () => resolve({ code: 1 }));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/runner.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git -C ../oxagen-cli-dev add apps/cli/src/tui/runner.ts apps/cli/src/tui/__tests__/runner.test.ts
git -C ../oxagen-cli-dev commit -m "feat(cli): assemble argv from form values and run commands as child processes"
```

---

#### Task 4: `banner.tsx` — ASCII-art welcome + dev test tooling

**Files:**
- Create: `apps/cli/src/tui/banner.tsx`
- Test: `apps/cli/src/tui/__tests__/banner.test.tsx`
- Modify: `apps/cli/package.json` (add `ink-testing-library` devDependency)

**Interfaces:**
- Consumes: `theme` from `./theme.js`.
- Produces: `export function Banner({ version }: { version: string }): React.ReactElement`.

- [ ] **Step 1: Add the test library and sync the lockfile**

```bash
cd ../oxagen-cli-dev
pnpm --filter @oxagen/cli add -D ink-testing-library@4.0.0
pnpm i --no-frozen-lockfile
```

Expected: `apps/cli/package.json` devDependencies now include `"ink-testing-library": "4.0.0"`.

- [ ] **Step 2: Write the failing test**

```tsx
// apps/cli/src/tui/__tests__/banner.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Banner } from "../banner.js";

describe("Banner", () => {
  it("renders the Oxagen wordmark, ring glyph, and version", () => {
    const { lastFrame } = render(<Banner version="0.4.0" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◯");
    expect(frame.toLowerCase()).toContain("oxagen");
    expect(frame).toContain("0.4.0");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/banner.test.tsx`
Expected: FAIL — cannot find module `../banner.js`.

- [ ] **Step 4: Write minimal implementation**

```tsx
// apps/cli/src/tui/banner.tsx
import { Box, Text } from "ink";
import React from "react";
import { theme } from "./theme.js";

// Block-letter OXAGEN wordmark. Kept as a literal so it renders identically
// across terminals (no figlet dependency).
const WORDMARK: string[] = [
  " ██████  ██   ██  █████   ██████  ███████ ███    ██",
  "██    ██  ██ ██  ██   ██ ██       ██      ████   ██",
  "██    ██   ███   ███████ ██   ███ █████   ██ ██  ██",
  "██    ██  ██ ██  ██   ██ ██    ██ ██      ██  ██ ██",
  " ██████  ██   ██ ██   ██  ██████  ███████ ██   ████",
];

export function Banner({ version }: { version: string }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {WORDMARK.map((line, i) => (
        <Text key={i} color={theme.violet} bold>
          {line}
        </Text>
      ))}
      <Text>
        <Text color={theme.cyan}>{theme.ring} </Text>
        <Text color={theme.violet} bold>
          Oxagen
        </Text>
        <Text dimColor>{`  ·  developer CLI  v${version}`}</Text>
      </Text>
    </Box>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/banner.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C ../oxagen-cli-dev add apps/cli/src/tui/banner.tsx apps/cli/src/tui/__tests__/banner.test.tsx apps/cli/package.json ../oxagen-cli-dev/pnpm-lock.yaml
git -C ../oxagen-cli-dev commit -m "feat(cli): ASCII-art Oxagen banner; add ink-testing-library"
```

---

#### Task 5: `command-form.tsx` — generic interactive argument form

**Files:**
- Create: `apps/cli/src/tui/command-form.tsx`
- Test: `apps/cli/src/tui/__tests__/command-form.test.tsx`
- Modify: `apps/cli/package.json` (add `@inkjs/ui` dependency)

**Interfaces:**
- Consumes: `CommandNode`, `OptSpec`, `ArgSpec` from `./command-tree.js`; `FormValues` from `./runner.js`; `theme`.
- Produces:
  ```ts
  export function CommandForm(props: {
    node: CommandNode;
    onSubmit: (values: FormValues) => void;
    onCancel: () => void;
  }): React.ReactElement
  ```
- Each field maps to a `FormValues` key: positional args → `arg:<name>`, options → `opt:<long>`. Boolean options render as a toggle (default from `defaultValue`); secret options render with `PasswordInput`; everything else with `TextInput`.

- [ ] **Step 1: Add `@inkjs/ui` and sync the lockfile**

```bash
cd ../oxagen-cli-dev
pnpm --filter @oxagen/cli add @inkjs/ui@2.0.0
pnpm i --no-frozen-lockfile
```

Expected: `apps/cli/package.json` dependencies include `"@inkjs/ui": "2.0.0"`.

- [ ] **Step 2: Write the failing test**

```tsx
// apps/cli/src/tui/__tests__/command-form.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CommandForm } from "../command-form.js";
import type { CommandNode } from "../command-tree.js";

const node: CommandNode = {
  name: "login",
  description: "Authenticate",
  path: ["auth", "login"],
  args: [],
  options: [
    { flags: "--email <e>", long: "--email", description: "Email", required: true, isBoolean: false, takesValue: true, secret: false },
    { flags: "--password <p>", long: "--password", description: "Password", required: true, isBoolean: false, takesValue: true, secret: true },
  ],
  children: [],
  runnable: true,
};

const ENTER = "\r";

describe("CommandForm", () => {
  it("renders a field per option and masks secret fields", () => {
    const { lastFrame } = render(<CommandForm node={node} onSubmit={() => {}} onCancel={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("--email");
    expect(frame).toContain("--password");
    expect(frame.toLowerCase()).toContain("required");
  });

  it("blocks submit while a required field is empty", () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<CommandForm node={node} onSubmit={onSubmit} onCancel={() => {}} />);
    stdin.write(ENTER); // attempt submit with empty required fields
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onCancel on escape", () => {
    const onCancel = vi.fn();
    const { stdin } = render(<CommandForm node={node} onSubmit={() => {}} onCancel={onCancel} />);
    stdin.write(""); // ESC
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/command-form.test.tsx`
Expected: FAIL — cannot find module `../command-form.js`.

- [ ] **Step 4: Write minimal implementation**

```tsx
// apps/cli/src/tui/command-form.tsx
import { PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { CommandNode } from "./command-tree.js";
import type { FormValues } from "./runner.js";
import { theme } from "./theme.js";

interface Field {
  key: string; // FormValues key: arg:<name> | opt:<long>
  label: string;
  description: string;
  required: boolean;
  kind: "text" | "secret" | "bool";
}

function fieldsOf(node: CommandNode): Field[] {
  const argFields: Field[] = node.args.map((a) => ({
    key: `arg:${a.name}`,
    label: `<${a.name}>`,
    description: a.description,
    required: a.required,
    kind: "text",
  }));
  const optFields: Field[] = node.options.map((o) => ({
    key: `opt:${o.long}`,
    label: o.long,
    description: o.description,
    required: o.required,
    kind: o.isBoolean ? "bool" : o.secret ? "secret" : "text",
  }));
  return [...argFields, ...optFields];
}

export function CommandForm(props: {
  node: CommandNode;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
}): React.ReactElement {
  const fields = fieldsOf(props.node);
  const [values, setValues] = useState<FormValues>(() => {
    const initial: FormValues = {};
    for (const f of fields) if (f.kind === "bool") initial[f.key] = false;
    return initial;
  });
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const missing = (): Field | undefined =>
    fields.find((f) => f.required && f.kind !== "bool" && !String(values[f.key] ?? "").trim());

  const trySubmit = () => {
    const m = missing();
    if (m) {
      setError(`${m.label} is required`);
      return;
    }
    props.onSubmit(values);
  };

  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    if (key.downArrow || key.tab) setActive((i) => Math.min(i + 1, fields.length - 1));
    else if (key.upArrow) setActive((i) => Math.max(i - 1, 0));
    else if (key.return) {
      const f = fields[active];
      if (f?.kind === "bool") setValues((v) => ({ ...v, [f.key]: !v[f.key] }));
      else if (active === fields.length - 1) trySubmit();
      else setActive((i) => Math.min(i + 1, fields.length - 1));
    } else if (input === " ") {
      const f = fields[active];
      if (f?.kind === "bool") setValues((v) => ({ ...v, [f.key]: !v[f.key] }));
    }
  });

  const setVal = (key: string, val: string) => setValues((v) => ({ ...v, [key]: val }));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.violet} bold>
          {props.node.path.join(" › ")}
        </Text>
      </Text>
      <Text dimColor>{props.node.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((f, i) => {
          const focused = i === active;
          return (
            <Box key={f.key} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color={focused ? theme.cyan : undefined}>{focused ? `${theme.pointer} ` : "  "}</Text>
                <Text bold={focused}>{f.label}</Text>
                {f.required ? <Text color={theme.violet}> (required)</Text> : null}
                {f.description ? <Text dimColor>{`  ${f.description}`}</Text> : null}
              </Text>
              <Box marginLeft={2}>
                {f.kind === "bool" ? (
                  <Text color={values[f.key] ? theme.cyan : undefined}>
                    {values[f.key] ? "[x] on" : "[ ] off"} {focused ? "(space toggles)" : ""}
                  </Text>
                ) : f.kind === "secret" ? (
                  <PasswordInput isDisabled={!focused} placeholder="•••" onChange={(val) => setVal(f.key, val)} />
                ) : (
                  <TextInput isDisabled={!focused} placeholder="…" onChange={(val) => setVal(f.key, val)} />
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>↑/↓ field · space toggles · ↵ next/submit · esc cancel</Text>
    </Box>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/command-form.test.tsx`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git -C ../oxagen-cli-dev add apps/cli/src/tui/command-form.tsx apps/cli/src/tui/__tests__/command-form.test.tsx apps/cli/package.json ../oxagen-cli-dev/pnpm-lock.yaml
git -C ../oxagen-cli-dev commit -m "feat(cli): generic interactive argument form with secret masking + validation"
```

---

#### Task 6: `app.tsx` — navigation state machine + launchTui

**Files:**
- Create: `apps/cli/src/tui/app.tsx`
- Test: `apps/cli/src/tui/__tests__/app.test.tsx`

**Interfaces:**
- Consumes: `buildCommandTree`, `CommandNode` from `./command-tree.js`; `assembleArgv`, `runCommand` from `./runner.js`; `Banner`; `CommandForm`; `theme`.
- Produces:
  ```ts
  export function App(props: { program: Command; version: string; onExit?: () => void }): React.ReactElement
  export function launchTui(program: Command, version: string): Promise<void>
  ```
- `launchTui` renders `<App>` with Ink's `render`, resolves when the user quits.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/cli/src/tui/__tests__/app.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Command } from "commander";
import { App } from "../app.js";

function program(): Command {
  const p = new Command("oxagen").description("Oxagen developer CLI");
  const auth = p.command("auth").description("Authentication");
  auth.command("login").description("Authenticate").option("--email <e>", "Email").action(() => {});
  auth.command("logout").description("Sign out").action(() => {});
  p.command("chat").description("Chat & messaging");
  return p;
}

const DOWN = "[B";
const ENTER = "\r";
const ESC = "";

describe("App", () => {
  it("renders banner + top-level groups", () => {
    const { lastFrame } = render(<App program={program()} version="0.4.0" />);
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toContain("oxagen");
    expect(frame).toContain("auth");
    expect(frame).toContain("chat");
  });

  it("drills into a group and back out", () => {
    const { lastFrame, stdin } = render(<App program={program()} version="0.4.0" />);
    stdin.write(ENTER); // enter "auth" (first item)
    expect(lastFrame()).toContain("login");
    expect(lastFrame()).toContain("logout");
    stdin.write(ESC); // back to groups
    expect(lastFrame()).toContain("chat");
  });

  it("filters the current list as you type", () => {
    const { lastFrame, stdin } = render(<App program={program()} version="0.4.0" />);
    stdin.write("ch");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("chat");
    expect(frame).not.toContain("auth");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/app.test.tsx`
Expected: FAIL — cannot find module `../app.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/cli/src/tui/app.tsx
import type { Command } from "commander";
import { Box, Text, useApp, useInput, render } from "ink";
import React, { useMemo, useState } from "react";
import { Banner } from "./banner.js";
import { CommandForm } from "./command-form.js";
import { buildCommandTree, type CommandNode } from "./command-tree.js";
import { assembleArgv, runCommand, type FormValues } from "./runner.js";
import { theme } from "./theme.js";

type Screen =
  | { kind: "list"; node: CommandNode }
  | { kind: "form"; node: CommandNode }
  | { kind: "result"; node: CommandNode; code: number };

export function App(props: { program: Command; version: string; onExit?: () => void }): React.ReactElement {
  const root = useMemo(() => buildCommandTree(props.program), [props.program]);
  const { exit } = useApp();
  const [stack, setStack] = useState<Screen[]>([{ kind: "list", node: root }]);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState("");
  const screen = stack[stack.length - 1];

  const quit = () => {
    props.onExit?.();
    exit();
  };
  const pop = () => {
    if (stack.length === 1) return quit();
    setStack((s) => s.slice(0, -1));
    setCursor(0);
    setFilter("");
  };
  const push = (s: Screen) => {
    setStack((prev) => [...prev, s]);
    setCursor(0);
    setFilter("");
  };

  const visibleChildren = (node: CommandNode): CommandNode[] =>
    node.children.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));

  useInput((input, key) => {
    if (screen.kind !== "list") return; // form/result handle their own input
    if (key.escape) return pop();
    if (input === "q" && filter === "") return quit();

    const items = visibleChildren(screen.node);
    if (key.downArrow) setCursor((c) => Math.min(c + 1, Math.max(items.length - 1, 0)));
    else if (key.upArrow) setCursor((c) => Math.max(c - 1, 0));
    else if (key.return) {
      const sel = items[cursor];
      if (!sel) return;
      if (sel.runnable) push({ kind: "form", node: sel });
      else push({ kind: "list", node: sel });
    } else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && input >= " ") setFilter((f) => f + input);
  });

  if (screen.kind === "form") {
    return (
      <CommandForm
        node={screen.node}
        onCancel={pop}
        onSubmit={async (values: FormValues) => {
          const argv = assembleArgv(screen.node, values);
          const { code } = await runCommand(screen.node, argv);
          setStack((s) => [...s.slice(0, -1), { kind: "result", node: screen.node, code }]);
        }}
      />
    );
  }

  if (screen.kind === "result") {
    return (
      <ResultView
        node={screen.node}
        code={screen.code}
        onBack={() => {
          setStack((s) => s.slice(0, -1));
          setCursor(0);
        }}
        onQuit={quit}
      />
    );
  }

  const items = visibleChildren(screen.node);
  const crumb = ["oxagen", ...screen.node.path].join(" › ");

  return (
    <Box flexDirection="column">
      {stack.length === 1 ? <Banner version={props.version} /> : null}
      <Box paddingX={1}>
        <Text color={theme.violet} bold>
          {crumb}
        </Text>
        {filter ? <Text dimColor>{`   /${filter}`}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>↑/↓ move · ↵ select · esc back · q quit · type to filter</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {items.length === 0 ? (
          <Text dimColor>no matches</Text>
        ) : (
          items.map((c, i) => (
            <Text key={c.name} color={i === cursor ? theme.cyan : undefined}>
              {i === cursor ? `${theme.pointer} ` : "  "}
              <Text bold={i === cursor}>{c.name.padEnd(16)}</Text>
              <Text dimColor>{c.description}</Text>
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

function ResultView(props: { node: CommandNode; code: number; onBack: () => void; onQuit: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || key.return) props.onBack();
    else if (input === "q") props.onQuit();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.violet} bold>
          {props.node.path.join(" › ")}
        </Text>{" "}
        <Text color={props.code === 0 ? "green" : "red"}>
          {props.code === 0 ? "✓ completed" : `✗ exit ${props.code}`}
        </Text>
      </Text>
      <Text dimColor>↵/esc back to menu · q quit</Text>
    </Box>
  );
}

export function launchTui(program: Command, version: string): Promise<void> {
  return new Promise((resolve) => {
    const { waitUntilExit } = render(<App program={program} version={version} onExit={() => {}} />);
    void waitUntilExit().then(() => resolve());
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/__tests__/app.test.tsx`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git -C ../oxagen-cli-dev add apps/cli/src/tui/app.tsx apps/cli/src/tui/__tests__/app.test.tsx
git -C ../oxagen-cli-dev commit -m "feat(cli): TUI navigation state machine (menu → command → form → result)"
```

---

#### Task 7: Activation seam in `index.tsx`

**Files:**
- Modify: `apps/cli/src/index.tsx` (replace the final `program.parse(...)` call)

**Interfaces:**
- Consumes: `launchTui` from `./tui/app.js` (lazy import).

- [ ] **Step 1: Find the current parse call**

Run: `grep -n "program.parse" apps/cli/src/index.tsx`
Expected: a single line near the bottom, e.g. `program.parse(process.argv);` or `program.parseAsync(...)`.

- [ ] **Step 2: Replace it with the activation seam**

Replace the `program.parse(process.argv);` line (and ensure the surrounding scope is an async IIFE or top-level await — this package is ESM, top-level await is allowed) with:

```ts
const noCommand = process.argv.slice(2).length === 0;
const wantsTui = noCommand && Boolean(process.stdout.isTTY) && !process.env.OXAGEN_NO_TUI;

if (wantsTui) {
  // Lazy-load Ink so the ~134 non-interactive commands never pay for it.
  const { launchTui } = await import("./tui/app.js");
  await launchTui(program, version);
} else {
  await program.parseAsync(process.argv);
}
```

If the file does not already use top-level `await`, wrap the tail in:

```ts
async function main(): Promise<void> {
  const noCommand = process.argv.slice(2).length === 0;
  const wantsTui = noCommand && Boolean(process.stdout.isTTY) && !process.env.OXAGEN_NO_TUI;
  if (wantsTui) {
    const { launchTui } = await import("./tui/app.js");
    await launchTui(program, version);
  } else {
    await program.parseAsync(process.argv);
  }
}
void main();
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm --filter @oxagen/cli typecheck && pnpm --filter @oxagen/cli build`
Expected: both succeed.

- [ ] **Step 4: Manual verification — non-interactive paths unchanged**

```bash
node apps/cli/dist/index.js --help        # prints commander help (unchanged)
node apps/cli/dist/index.js --version      # prints 0.4.0
node apps/cli/dist/index.js auth --help    # prints auth subcommands (unchanged)
node apps/cli/dist/index.js | cat          # non-TTY → help, NOT the TUI
OXAGEN_NO_TUI=1 node apps/cli/dist/index.js # prints help, NOT the TUI
```
Expected: all behave exactly as before; none launch the TUI.

- [ ] **Step 5: Manual verification — TUI launches interactively**

In a real terminal: `node apps/cli/dist/index.js`
Expected: the banner + groups menu appears; ↑/↓ moves, Enter drills into `auth`, Esc backs out, `q` quits.

- [ ] **Step 6: Commit**

```bash
git -C ../oxagen-cli-dev add apps/cli/src/index.tsx
git -C ../oxagen-cli-dev commit -m "feat(cli): launch interactive TUI for bare TTY invocation (OXAGEN_NO_TUI opt-out)"
```

---

#### Task 8: Documentation + final verification

**Files:**
- Modify: `apps/cli/README.md` (document the interactive TUI)
- Modify: `README.md` (one line under the CLI section)

**Interfaces:** none.

- [ ] **Step 1: Document the TUI in `apps/cli/README.md`**

Add after the "Installation" / before "Authentication" section:

```markdown
## Interactive mode

Run `oxagen` with no arguments in a terminal to open the interactive TUI: an
ASCII banner and a keyboard-navigable menu of every command group and command.

- `↑/↓` move · `↵` select · `Esc` back · `q` quit · type to filter
- Selecting a command opens a form for its arguments and flags, then runs it.
- Secret inputs (passwords, tokens) are masked.

Disable it (always print help instead) with `OXAGEN_NO_TUI=1`. Non-interactive
usage — `oxagen <command> …`, pipes, and CI — is unaffected.
```

- [ ] **Step 2: Add one line to the root `README.md` CLI section**

Under the `### CLI (oxagen) — local development binary` section, add:

```markdown
Running `oxagen` with no args in a terminal opens an interactive TUI (banner +
menu + argument forms); `OXAGEN_NO_TUI=1` or any subcommand/pipe keeps the
classic non-interactive behavior.
```

- [ ] **Step 3: Run the full set of new TUI tests (package-scoped, allowed)**

Run: `pnpm --filter @oxagen/cli test:unit -- tui/`
Expected: all TUI test files pass.

- [ ] **Step 4: Lint + typecheck the package**

Run: `pnpm --filter @oxagen/cli lint && pnpm --filter @oxagen/cli typecheck`
Expected: zero warnings, no type errors.

- [ ] **Step 5: Capture visible proof**

Build and run a scripted render via ink-testing-library (or `node dist/index.js` in a TTY) and paste the rendered banner+menu frame into the PR as the proof artifact.

```bash
pnpm --filter @oxagen/cli build
```

- [ ] **Step 6: Commit and push**

```bash
git -C ../oxagen-cli-dev add apps/cli/README.md README.md
git -C ../oxagen-cli-dev commit -m "docs(cli): document interactive TUI mode and OXAGEN_NO_TUI"
git -C ../oxagen-cli-dev push origin feat/cli-dev-binary-and-daemon-adr
```

---

### Self-Review

**Spec coverage:**
- Banner → Task 4. Menu launcher + nav + filter → Task 6. Interactive arg forms + masking + validation → Task 5. Commander introspection (menu + forms generated) → Task 2. Execution → Task 3 (refined to child-process; noted). Activation seam / non-breaking + `OXAGEN_NO_TUI` → Task 7. Theme extraction + DevStatus refactor → Task 1. `@inkjs/ui` dep → Task 5; `ink-testing-library` → Task 4. Tests for every unit → in each task. Docs → Task 8. All spec sections covered.
- Deviation from spec: execution is child-process spawn rather than in-process `parseAsync` (Task 3 note). Same external behavior; more robust for repeat runs. Flag to user.

**Placeholder scan:** No TBD/TODO; every code and test block is concrete. Manual-verification steps list exact commands and expected output.

**Type consistency:** `CommandNode`/`ArgSpec`/`OptSpec` defined in Task 2 and used identically in Tasks 3/5/6. `FormValues` defined in Task 3, consumed in Tasks 5/6. Form keys `arg:<name>` / `opt:<long>` defined in Task 3 and used by `command-form.tsx` (Task 5) and `assembleArgv` (Task 3). `launchTui(program, version)` defined in Task 6, called in Task 7. `Banner({version})` (Task 4) used in Task 6. `CommandForm({node,onSubmit,onCancel})` (Task 5) used in Task 6.

**Risks / watch-items for the implementer:**
- `@inkjs/ui` `TextInput`/`PasswordInput` prop names (`isDisabled`, `onChange`, `placeholder`) are for v2.0.0 — verify against the installed types; adjust if the API differs.
- `ink-testing-library` key escape codes: down=`[B`, enter=`\r`, esc=``. If a focused `@inkjs/ui` input swallows ESC in the form, route ESC via a top-level `useInput` in `command-form.tsx` (already done) and confirm the test passes.
- Coverage gate: if the package threshold dips, the TUI tests in each task should cover the gap; do not lower thresholds.

