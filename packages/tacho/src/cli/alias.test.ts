/**
 * `tacho`, `tachod`, and `tacho-hook` are hidden aliases of the `oxagen` CLI
 * (#4879). Each prints one line naming the command that replaced it, and none
 * prints into an output another program reads.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aliasNotice, OXAGEN_COMMAND_FOR, printAliasNotice } from "./alias";

const argv = (...rest: string[]) => ["node", "/usr/local/bin/tacho", ...rest];
const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the tacho alias", () => {
  it.each(Object.entries(OXAGEN_COMMAND_FOR))(
    "names the command `tacho %s` moved to",
    (command, replacement) => {
      // A person at a terminal sees the line for every command.
      expect(aliasNotice("tacho", argv(command), true)).toBe(
        `\`tacho ${command}\` is now \`${replacement}\`. The old name still works.`,
      );
    },
  );

  it("moves every person-facing command onto `oxagen agent`", () => {
    for (const command of [
      "enroll",
      "status",
      "unenroll",
      "reassign",
      "export",
      "verify",
      "run",
      "detect",
    ])
      expect(OXAGEN_COMMAND_FOR[command]).toBe(`oxagen agent ${command}`);
  });

  it("points a bare or unknown invocation at `oxagen agent --help`", () => {
    for (const rest of [[], ["--version"], ["frobnicate"]])
      expect(aliasNotice("tacho", argv(...rest), false)).toBe(
        "tacho is now the `oxagen` CLI. Run `oxagen agent --help` for the commands that replaced it.",
      );
  });

  it.each(["hook", "mcp-stdio", "credential", "github"])(
    "stays silent for `tacho %s` when a program runs it (negative)",
    (command) => {
      // A harness, a connected app, Claude Code, or git reads this output.
      expect(aliasNotice("tacho", argv(command), false)).toBeUndefined();
    },
  );

  it("still prints for `tacho daemon` under a service manager, into its log", () => {
    expect(aliasNotice("tacho", argv("daemon"), false)).toBe(
      "`tacho daemon` is now `oxagen daemon`. The old name still works.",
    );
  });
});

describe("the tachod alias", () => {
  it("names `oxagen daemon` every time it starts, since a service starts it", () => {
    for (const tty of [true, false])
      expect(aliasNotice("tachod", ["node", "tachod.mjs"], tty)).toBe(
        "tachod is now `oxagen daemon`. Run `oxagen agent status` to move this machine's service to the new name.",
      );
  });
});

describe("the tacho-hook alias", () => {
  it("names `oxagen hook` to a person at a terminal", () => {
    expect(aliasNotice("tacho-hook", ["node", "tacho-hook.mjs"], true)).toBe(
      "tacho-hook is now `oxagen hook`.",
    );
  });

  it("stays silent when a harness runs it (negative)", () => {
    expect(
      aliasNotice("tacho-hook", ["node", "tacho-hook.mjs"], false),
    ).toBeUndefined();
  });
});

describe("a sidecar the desktop app starts", () => {
  it.each([
    ["tacho", ["node", "tacho", "enroll"]],
    ["tachod", ["node", "tachod.mjs"]],
    ["tacho-hook", ["node", "tacho-hook.mjs"]],
  ] as const)("prints nothing for %s (negative)", (executable, args) => {
    expect(
      aliasNotice(executable, args, true, { OXAGEN_DESKTOP_SIDECAR: "1" }),
    ).toBeUndefined();
  });
});

describe("printAliasNotice", () => {
  it("writes one line to stderr, or nothing", () => {
    const written: string[] = [];
    const write = (text: string) => {
      written.push(text);
    };
    printAliasNotice("tacho", argv("status"), false, write, {});
    printAliasNotice("tacho-hook", ["node", "tacho-hook.mjs"], false, write, {});
    expect(written).toEqual([
      "`tacho status` is now `oxagen agent status`. The old name still works.\n",
    ]);
  });

  // Each executable's entry prints the notice before it does anything else.
  it.each([
    ["tacho", "cli/main.ts"],
    ["tacho", "cli/native.ts"],
    ["tachod", "collector/main.ts"],
    ["tacho-hook", "claude-code/hook-main.ts"],
  ])("is called by the %s entry in %s", (executable, file) => {
    expect(readFileSync(resolve(src, file), "utf8")).toContain(
      `printAliasNotice("${executable}")`,
    );
  });
});
