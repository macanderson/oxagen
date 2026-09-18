import { describe, expect, it } from "vitest";
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
const CODEX = "/repo/.codex/hooks.json";

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
  it("writes each harness to its own project-scoped file", () => {
    expect(hookConfigPath(ROOT, "claude-code")).toBe(CLAUDE);
    expect(hookConfigPath(ROOT, "codex")).toBe(CODEX);
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
