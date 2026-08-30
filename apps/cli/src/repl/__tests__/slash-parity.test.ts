/**
 * Proves the slash-command catalog (catalog.ts's BUILTIN_SLASH_COMMANDS — the
 * single source the `/` typeahead menu and `/help` both read from) and the
 * REPL's inline dispatcher (the `if (text === "/x")` / `if
 * (text.startsWith("/x"))` chain in interactive.tsx's handleSubmit) name
 * exactly the same set of built-in commands.
 *
 * interactive.tsx is the most contested file in the tree, so this reads its
 * source as text and mines the literal `/name` tokens the dispatcher checks,
 * rather than refactoring the dispatcher into a generated table — a
 * regression guard, not a redesign. It already caught one real drift bug
 * (`/effort` was fully implemented in the dispatcher but absent from the
 * catalog — invisible in the menu and undocumented in `/help`, now fixed by
 * adding it to BUILTIN_SLASH_COMMANDS).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUILTIN_SLASH_NAMES } from "../../slash/catalog.js";
import { HELP } from "../components.js";

const here = dirname(fileURLToPath(import.meta.url));
const INTERACTIVE_SOURCE = readFileSync(
  join(here, "../interactive.tsx"),
  "utf8",
);

// The dispatcher lives between these two existing comments in interactive.tsx.
// If either moves, the "canary" test below fails loudly (empty/tiny extracted
// set) instead of the real parity assertions silently passing on nothing.
const START_MARKER = "// ── Slash commands ──";
const END_MARKER = "// User-defined slash commands";

/**
 * The set of `/name` command names the inline dispatcher actually handles,
 * mined from the `cmd === "/name"` checks inside the dispatcher block only. The
 * dispatcher matches on the leading command TOKEN (`const cmd = text.split(...)`)
 * rather than a `text ===` / `text.startsWith` prefix, so this keys on
 * `cmd === "/name"` — which also means the explanatory `text === "/help"` prose
 * in the block's header comment is NOT mined as a command (it isn't a `cmd`
 * check), keeping the extraction precise.
 */
function dispatchedCommandNames(): Set<string> {
  const start = INTERACTIVE_SOURCE.indexOf(START_MARKER);
  const end = INTERACTIVE_SOURCE.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "slash-parity: couldn't locate the dispatcher block in interactive.tsx — " +
        "the anchor comments moved. Update START_MARKER/END_MARKER in this test.",
    );
  }
  const block = INTERACTIVE_SOURCE.slice(start, end);
  const names = new Set<string>();
  // Command names may contain hyphens (e.g. /worker-model), so match [a-zA-Z-]+,
  // not just letters — otherwise "/worker-model" would mine as "worker".
  const pattern = /cmd\s*===\s*"\/([a-zA-Z-]+)"/g;
  for (const m of block.matchAll(pattern)) {
    names.add(m[1] as string);
  }
  return names;
}

describe("slash command parity — catalog (menu/help) vs REPL dispatcher", () => {
  it("extracts a sane, non-trivial set of dispatched command names (canary)", () => {
    expect(dispatchedCommandNames().size).toBeGreaterThan(10);
  });

  it("every catalog built-in is actually handled by the dispatcher", () => {
    const dispatched = dispatchedCommandNames();
    const missing = [...BUILTIN_SLASH_NAMES].filter(
      (name) => !dispatched.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("the dispatcher handles no command absent from the catalog (so /help and the menu can't omit a real command)", () => {
    const dispatched = dispatchedCommandNames();
    const extra = [...dispatched].filter(
      (name) => !BUILTIN_SLASH_NAMES.has(name),
    );
    expect(extra).toEqual([]);
  });
});

describe("slash command parity — /help text lists every shipped built-in", () => {
  // HELP is generated from BUILTIN_SLASH_COMMANDS (formatBuiltinCommandLines),
  // so it can't drift from the catalog by construction — this pins that
  // contract, and catches a regression if someone ever hand-writes HELP again.
  it("every dispatched built-in appears in the /help text as /name", () => {
    const dispatched = dispatchedCommandNames();
    const missing = [...dispatched].filter(
      (name) => !HELP.includes(`/${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("every catalog built-in appears in the /help text as /name", () => {
    const missing = [...BUILTIN_SLASH_NAMES].filter(
      (name) => !HELP.includes(`/${name}`),
    );
    expect(missing).toEqual([]);
  });
});
