/**
 * check-tacho-commands.mjs (#4879): the guard that fails on a user-facing
 * string telling a person to type a `tacho` command. It must catch each shape
 * an instruction takes, pass the names that stay (the directory, the wire
 * format, the tables), read strings but not comments, and allow the aliases
 * that name the old command on purpose.
 */
import { describe, expect, it } from "vitest";
import {
  excerpt,
  findTachoCommands,
  isScannedProse,
  isScannedSource,
  namesTachoCommand,
  stringsIn,
} from "./check-tacho-commands.mjs";

describe("namesTachoCommand", () => {
  it.each([
    "Run `tacho enroll` first.",
    "run tacho status to repair it",
    "`oxagen tacho reassign --default`",
    "tacho-hook hook --agent x",
    '"$HOME/bin/tacho" unenroll --all --purge',
    "`tachod`",
    "`tacho-hook --harness cursor`",
    "the `oxagen` and `tacho` commands",
    '["tacho", "hook", "--agent", agent]',
    'spawnSync("tacho", ["hook", "--agent", agent])',
    "`tacho credential status`",
    "tacho github configure --repository a/b",
    "with the <code>tacho hook</code> command",
  ])("flags %s", (text) => {
    expect(namesTachoCommand(text)).toBe(true);
  });

  it.each([
    "~/.config/oxagen/tacho/host.json",
    "`tacho.hosts` and `tacho.enrollment_tokens`",
    "--format tacho | trace | otlp",
    "tachod: unhandled rejection",
    "tacho-hook: stdin is not JSON",
    "tacho credential: no token",
    "# >>> tacho enrollment tch_0123 >>>",
    "`tachod.log`",
    "`oxagen agent enroll`",
    "packages/tacho/src/cli/alias.ts",
  ])("passes %s (negative)", (text) => {
    expect(namesTachoCommand(text)).toBe(false);
  });
});

describe("findTachoCommands", () => {
  it("reads string literals, template text, and JSX text, not comments", () => {
    const source = [
      "// Run `tacho enroll` in a comment: allowed.",
      "/** `tacho status` in a doc comment: allowed. */",
      'const a = "Run `tacho enroll` first.";',
      "const b = `Run \\`tacho unenroll --harness ${h}\\` again`;",
      "const c = <p>Wrap it with tacho hook once set up.</p>;",
      'const d = "Run `oxagen agent status`.";',
    ].join("\n");
    expect(
      findTachoCommands("apps/desktop/src/x.tsx", source).map((f: { line: number }) => f.line),
    ).toEqual([3, 4, 5]);
  });

  it("allows a string marked as an alias, on its line or the line before", () => {
    const source = [
      "// tacho-command-check: alias",
      "const a = `\\`tacho ${verb}\\` is now \\`oxagen agent ${verb}\\``;",
      'const b = "`tacho enroll`"; // tacho-command-check: alias',
      "const unrelated = 1;",
      'const c = "`tacho enroll`";',
    ].join("\n");
    expect(
      findTachoCommands("packages/tacho/src/cli/x.ts", source).map(
        (f: { line: number }) => f.line,
      ),
    ).toEqual([5]);
  });

  it("reads every line of a document", () => {
    const doc = "# Enroll\n\n```bash\ntacho enroll --harness codex\n```\n\nRun `oxagen agent status`.\n";
    expect(
      findTachoCommands("apps/docs/content/docs/cli/x.mdx", doc),
    ).toEqual([{ line: 4, text: "tacho enroll --harness codex" }]);
  });

  it("joins a template's text, so a command split by a substitution is seen", () => {
    expect(
      stringsIn("a.ts", "const x = `run tacho ${verb} now`;").map(
        (s) => s.text,
      ),
    ).toEqual(["run tacho   now"]);
    expect(
      stringsIn("a.ts", "const x = `run \\`tacho status\\` ${now}`;")[0]?.text,
    ).toContain("`tacho status`");
  });
});

describe("scope", () => {
  it.each([
    ["apps/cli/src/program.ts", true],
    ["packages/tacho/src/cli/enroll.ts", true],
    ["apps/desktop/src/app.tsx", true],
    ["apps/cli/src/commands/__tests__/tacho.test.ts", false],
    ["packages/tacho/src/cli/enroll.test.ts", false],
    ["apps/app/src/features/x.tsx", false],
  ])("reads source %s: %s", (path, scanned) => {
    expect(isScannedSource(path)).toBe(scanned);
  });

  it.each([
    ["AGENTS.md", true],
    ["apps/cli/README.md", true],
    ["apps/docs/content/docs/cli/wrap-an-agent.mdx", true],
    ["apps/docs/content/docs/releases/v2.1.3.mdx", false],
    ["apps/app/messages/onboarding.json", true],
    ["apps/web/products/oxagen/index.html", true],
    ["apps/web/story/index.html", false],
    ["docs/adr/ADR-152-the-contained-launcher.md", false],
    ["docs/guides/contained-runs.md", true],
    ["CLAUDE.md", false],
  ])("reads document %s: %s", (path, scanned) => {
    expect(isScannedProse(path)).toBe(scanned);
  });
});

describe("excerpt", () => {
  it("shows the command on one line, from a long multi-line string", () => {
    const text = `${"x ".repeat(60)}\n<p>The <code>tacho</code> executable</p>`;
    const shown = excerpt(text);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown).toContain("<code>tacho</code>");
    expect(shown).not.toContain("\n");
  });
});
