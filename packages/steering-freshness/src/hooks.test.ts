import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOOK_MARKER,
  hookCommand,
  hookConfigPath,
  hookStatus,
  installHook,
  removeHook,
  type HookIo,
} from "./hooks";

const ROOT = "/repo";
const CLAUDE = "/repo/.claude/settings.json";
// Codex has no project-scoped hook file: it reads `$CODEX_HOME/hooks.json`
// and nothing else, so the path is pinned through the environment rather than
// derived from the project root.
const CODEX_HOME = "/home/dev/.codex";
const CODEX = "/home/dev/.codex/hooks.json";

let previousCodexHome: string | undefined;
beforeEach(() => {
  previousCodexHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = CODEX_HOME;
});
afterEach(() => {
  if (previousCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = previousCodexHome;
});

function io(files: Record<string, string> = {}): HookIo & {
  files: Record<string, string>;
} {
  return {
    files,
    read: (async (p: unknown) => {
      const key = String(p);
      if (!(key in files)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files[key]!;
    }) as unknown as HookIo["read"],
    write: (async (p: unknown, data: unknown) => {
      files[String(p)] = String(data);
    }) as unknown as HookIo["write"],
    mkdirp: async () => undefined,
  };
}

const parse = (store: { files: Record<string, string> }, path: string) =>
  JSON.parse(store.files[path]!) as Record<string, unknown>;

describe("hookConfigPath", () => {
  it("writes Claude Code beside the project and Codex where Codex reads", () => {
    expect(hookConfigPath(ROOT, "claude-code")).toBe(CLAUDE);
    expect(hookConfigPath(ROOT, "codex")).toBe(CODEX);
  });

  // Writing `<project>/.codex/hooks.json` reported a successful install over
  // a file Codex never opens, leaving the gate inactive on a harness the
  // command advertises.
  it("never puts the Codex hook under the project root", () => {
    expect(hookConfigPath(ROOT, "codex")).not.toContain(ROOT);
  });

  it("falls back to ~/.codex when CODEX_HOME is unset", () => {
    expect(hookConfigPath(ROOT, "codex", {}, "/home/dev")).toBe(
      "/home/dev/.codex/hooks.json",
    );
  });
});

describe("installHook", () => {
  it("creates the config when there is none", async () => {
    const store = io();
    const result = await installHook(ROOT, "claude-code", store);
    expect(result.outcome).toBe("installed");
    const config = parse(store, CLAUDE) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(config.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      hookCommand("claude-code"),
    );
  });

  it("passes the harness name, so the renderer is chosen at run time", async () => {
    expect(hookCommand("codex")).toContain("--harness codex");
    expect(hookCommand("codex")).toContain(HOOK_MARKER);
  });

  // The file belongs to the developer. Everything that is not ours survives.
  it("keeps the rest of the file untouched", async () => {
    const store = io({
      [CLAUDE]: JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "their-lint" }] }],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "their-check" }] },
          ],
        },
      }),
    });
    await installHook(ROOT, "claude-code", store);
    const config = parse(store, CLAUDE) as {
      permissions: unknown;
      hooks: {
        PreToolUse: unknown[];
        UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    expect(config.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.UserPromptSubmit).toHaveLength(2);
    expect(config.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      "their-check",
    );
  });

  it("is idempotent, and reports the second run as an update", async () => {
    const store = io();
    await installHook(ROOT, "claude-code", store);
    const again = await installHook(ROOT, "claude-code", store);
    expect(again.outcome).toBe("updated");
    const config = parse(store, CLAUDE) as {
      hooks: { UserPromptSubmit: unknown[] };
    };
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("replaces an entry written by an older version", async () => {
    const store = io({
      [CLAUDE]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: "oxagen steering gate --old-flag" },
              ],
            },
          ],
        },
      }),
    });
    await installHook(ROOT, "claude-code", store);
    const config = parse(store, CLAUDE) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    expect(config.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      hookCommand("claude-code"),
    );
  });

  // A half-understood rewrite of someone's hook config is worse than not
  // installing at all.
  it("refuses a config it cannot parse, and writes nothing", async () => {
    const store = io({ [CLAUDE]: "{ not json" });
    const result = await installHook(ROOT, "claude-code", store);
    expect(result.outcome).toBe("refused");
    expect(store.files[CLAUDE]).toBe("{ not json");
  });

  it("treats an empty file as an empty config", async () => {
    const store = io({ [CLAUDE]: "  \n" });
    const result = await installHook(ROOT, "claude-code", store);
    expect(result.outcome).toBe("installed");
  });

  // Valid JSON with the wrong shape reached the array methods and threw
  // instead of refusing.
  it("refuses a config whose hook shape is wrong, and leaves it alone", async () => {
    const shapes = [
      '{"hooks":"nope"}',
      '{"hooks":{"UserPromptSubmit":{"hooks":[]}}}',
      '{"hooks":{"UserPromptSubmit":["nope"]}}',
      '{"hooks":{"UserPromptSubmit":[{"hooks":{}}]}}',
      '{"hooks":{"UserPromptSubmit":[{"hooks":["nope"]}]}}',
    ];
    for (const text of shapes) {
      const store = io({ [CLAUDE]: text });
      expect((await installHook(ROOT, "claude-code", store)).outcome).toBe(
        "refused",
      );
      expect((await removeHook(ROOT, "claude-code", store)).outcome).toBe(
        "refused",
      );
      expect((await hookStatus(ROOT, "claude-code", store)).installed).toBe(
        false,
      );
      expect(store.files[CLAUDE]).toBe(text);
    }
  });
});

describe("removeHook", () => {
  it("takes the entry back out and leaves the others", async () => {
    const store = io({
      [CLAUDE]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "their-check" }] },
          ],
        },
      }),
    });
    await installHook(ROOT, "claude-code", store);
    const result = await removeHook(ROOT, "claude-code", store);
    expect(result.outcome).toBe("removed");
    const config = parse(store, CLAUDE) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    expect(config.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      "their-check",
    );
  });

  it("drops the empty hooks key rather than leaving a husk", async () => {
    const store = io();
    await installHook(ROOT, "codex", store);
    await removeHook(ROOT, "codex", store);
    expect(parse(store, CODEX)).toEqual({});
  });

  it("says absent when there is nothing installed", async () => {
    const store = io({ [CLAUDE]: JSON.stringify({ hooks: {} }) });
    expect((await removeHook(ROOT, "claude-code", store)).outcome).toBe(
      "absent",
    );
  });

  it("says absent when there is no config file", async () => {
    expect((await removeHook(ROOT, "claude-code", io())).outcome).toBe(
      "absent",
    );
  });

  it("refuses a config it cannot parse", async () => {
    const store = io({ [CLAUDE]: "{ not json" });
    expect((await removeHook(ROOT, "claude-code", store)).outcome).toBe(
      "refused",
    );
  });
});

describe("hookStatus", () => {
  it("reports installed after an install, and not before", async () => {
    const store = io();
    expect((await hookStatus(ROOT, "codex", store)).installed).toBe(false);
    await installHook(ROOT, "codex", store);
    expect((await hookStatus(ROOT, "codex", store)).installed).toBe(true);
    await removeHook(ROOT, "codex", store);
    expect((await hookStatus(ROOT, "codex", store)).installed).toBe(false);
  });

  it("reports not installed for an unparseable config rather than throwing", async () => {
    const store = io({ [CODEX]: "{" });
    expect((await hookStatus(ROOT, "codex", store)).installed).toBe(false);
  });
});

// Cursor and Stella joined Claude Code and Codex (ADR-101: no harness-facing
// export is done until every wrapped harness can load it).
const HOME = "/home/dev";
const CURSOR = "/home/dev/.cursor/hooks.json";

describe("hookConfigPath, cursor and stella", () => {
  it("writes Cursor to the user hooks file, with no project scope", () => {
    expect(hookConfigPath(ROOT, "cursor", {}, HOME)).toBe(CURSOR);
    expect(hookConfigPath(ROOT, "cursor", {}, HOME)).not.toContain(ROOT);
  });

  it("prefers stella.toml, honouring STELLA_HOME", () => {
    expect(hookConfigPath(ROOT, "stella", {}, HOME)).toBe(
      "/home/dev/.stella/stella.toml",
    );
    expect(
      hookConfigPath(ROOT, "stella", { STELLA_HOME: "/opt/stella" }, HOME),
    ).toBe("/opt/stella/stella.toml");
  });
});

describe("installHook / removeHook / hookStatus, cursor", () => {
  it("installs a flat beforeSubmitPrompt entry with version: 1", async () => {
    const store = io();
    const result = await installHook(ROOT, "cursor", store, {}, HOME);
    expect(result.outcome).toBe("installed");
    const config = parse(store, CURSOR) as {
      version: number;
      hooks: { beforeSubmitPrompt: Array<{ command: string }> };
    };
    expect(config.version).toBe(1);
    expect(config.hooks.beforeSubmitPrompt[0]!.command).toBe(
      hookCommand("cursor"),
    );
  });

  it("keeps a developer's other Cursor hooks and events untouched", async () => {
    const store = io({
      [CURSOR]: JSON.stringify({
        version: 1,
        hooks: {
          beforeSubmitPrompt: [{ type: "command", command: "their-check" }],
          stop: [{ type: "command", command: "their-stop" }],
        },
      }),
    });
    await installHook(ROOT, "cursor", store, {}, HOME);
    const config = parse(store, CURSOR) as {
      hooks: {
        beforeSubmitPrompt: Array<{ command: string }>;
        stop: unknown[];
      };
    };
    expect(config.hooks.beforeSubmitPrompt).toHaveLength(2);
    expect(config.hooks.stop).toHaveLength(1);
  });

  it("is idempotent, and removal leaves a foreign hook and version alone", async () => {
    const store = io();
    await installHook(ROOT, "cursor", store, {}, HOME);
    const again = await installHook(ROOT, "cursor", store, {}, HOME);
    expect(again.outcome).toBe("updated");

    const removed = await removeHook(ROOT, "cursor", store, {}, HOME);
    expect(removed.outcome).toBe("removed");
    expect(parse(store, CURSOR)).toEqual({});
  });

  it("refuses a config that is not JSON, and writes nothing", async () => {
    const store = io({ [CURSOR]: "{ not json" });
    const result = await installHook(ROOT, "cursor", store, {}, HOME);
    expect(result.outcome).toBe("refused");
    expect(store.files[CURSOR]).toBe("{ not json");
  });

  it("reports status honestly across install and remove", async () => {
    const store = io();
    expect((await hookStatus(ROOT, "cursor", store, {}, HOME)).installed).toBe(
      false,
    );
    await installHook(ROOT, "cursor", store, {}, HOME);
    expect((await hookStatus(ROOT, "cursor", store, {}, HOME)).installed).toBe(
      true,
    );
    await removeHook(ROOT, "cursor", store, {}, HOME);
    expect((await hookStatus(ROOT, "cursor", store, {}, HOME)).installed).toBe(
      false,
    );
  });
});

describe("installHook / removeHook / hookStatus, stella", () => {
  const TOML = "/home/dev/.stella/stella.toml";
  const JSON_PATH = "/home/dev/.stella/settings.json";

  it("creates stella.toml when neither file exists", async () => {
    const store = io();
    const result = await installHook(ROOT, "stella", store, {}, HOME);
    expect(result.outcome).toBe("installed");
    expect(result.path).toBe(TOML);
    expect(store.files[TOML]).toContain("[[hooks.UserPromptSubmit]]");
    expect(store.files[TOML]).toContain(hookCommand("stella"));
    expect(store.files[TOML]).toContain(
      "oxagen steering gate (managed by oxagen; do not edit)",
    );
  });

  it("appends after a developer's existing TOML rather than replacing it", async () => {
    const store = io({
      [TOML]:
        '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "their-stop"\n',
    });
    await installHook(ROOT, "stella", store, {}, HOME);
    expect(store.files[TOML]).toContain('command = "their-stop"');
    expect(store.files[TOML]).toContain("[[hooks.UserPromptSubmit]]");
  });

  it("is idempotent: installing twice leaves one managed block", async () => {
    const store = io();
    await installHook(ROOT, "stella", store, {}, HOME);
    const again = await installHook(ROOT, "stella", store, {}, HOME);
    expect(again.outcome).toBe("updated");
    const occurrences = (
      store.files[TOML]!.match(/\[\[hooks\.UserPromptSubmit\]\]/g) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });

  it("refuses when UserPromptSubmit is already a table, rather than writing a duplicate key", async () => {
    const store = io({
      [TOML]: '[hooks.UserPromptSubmit]\ncommand = "mine"\n',
    });
    const result = await installHook(ROOT, "stella", store, {}, HOME);
    expect(result.outcome).toBe("refused");
    expect(store.files[TOML]).toBe(
      '[hooks.UserPromptSubmit]\ncommand = "mine"\n',
    );
  });

  it("prefers the legacy settings.json when only it exists", async () => {
    const store = io({ [JSON_PATH]: "{}" });
    const result = await installHook(ROOT, "stella", store, {}, HOME);
    expect(result.path).toBe(JSON_PATH);
    const config = parse(store, JSON_PATH) as {
      hooks: {
        UserPromptSubmit: Array<{
          hooks: Array<{ command: string; timeoutMs: number }>;
        }>;
      };
    };
    expect(config.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      hookCommand("stella"),
    );
    expect(config.hooks.UserPromptSubmit[0]!.hooks[0]!.timeoutMs).toBe(20_000);
    // stella.toml never got created just because the install ran.
    expect(store.files[TOML]).toBeUndefined();
  });

  it("removes the managed TOML block and nothing else", async () => {
    const store = io({
      [TOML]:
        '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "their-stop"\n',
    });
    await installHook(ROOT, "stella", store, {}, HOME);
    const removed = await removeHook(ROOT, "stella", store, {}, HOME);
    expect(removed.outcome).toBe("removed");
    expect(store.files[TOML]).toContain('command = "their-stop"');
    expect(store.files[TOML]).not.toContain("hooks.UserPromptSubmit");
  });

  it("reports status honestly across install and remove, for TOML", async () => {
    const store = io();
    expect((await hookStatus(ROOT, "stella", store, {}, HOME)).installed).toBe(
      false,
    );
    await installHook(ROOT, "stella", store, {}, HOME);
    expect((await hookStatus(ROOT, "stella", store, {}, HOME)).installed).toBe(
      true,
    );
    await removeHook(ROOT, "stella", store, {}, HOME);
    expect((await hookStatus(ROOT, "stella", store, {}, HOME)).installed).toBe(
      false,
    );
  });
});
