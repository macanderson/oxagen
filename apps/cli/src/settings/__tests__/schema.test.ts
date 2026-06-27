import { describe, it, expect } from "vitest";
import { oxagenSettingsSchema, permissionsSchema, hooksSchema } from "../schema.js";

describe("oxagenSettingsSchema", () => {
  it("parses a full settings document", () => {
    const parsed = oxagenSettingsSchema.parse({
      model: "anthropic/claude-sonnet-4.6",
      apiUrl: "https://api.oxagen.sh",
      env: { FOO: "bar" },
      permissions: { defaultMode: "default", deny: ["Bash(rm -rf*)"], allow: ["Bash(git*)"] },
      hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      mcpServers: {
        github: { transport: "stdio", command: "npx", args: ["-y", "server-github"] },
      },
      toolVisibility: { github: { include: ["create_*"] } },
    });
    expect(parsed.model).toBe("anthropic/claude-sonnet-4.6");
    expect(parsed.permissions?.deny).toContain("Bash(rm -rf*)");
    expect(parsed.mcpServers?.github?.transport).toBe("stdio");
  });

  it("defaults a hook action's type to 'command'", () => {
    const parsed = hooksSchema.parse({
      PreToolUse: [{ hooks: [{ command: "echo hi" }] }],
    });
    expect(parsed.PreToolUse?.[0]?.hooks[0]?.type).toBe("command");
  });

  it("rejects an invalid apiUrl", () => {
    expect(() => oxagenSettingsSchema.parse({ apiUrl: "not-a-url" })).toThrow();
  });

  it("rejects an unknown permission mode", () => {
    expect(() => permissionsSchema.parse({ defaultMode: "yolo" })).toThrow();
  });

  it("rejects a hook matcher with no actions", () => {
    expect(() => hooksSchema.parse({ PreToolUse: [{ matcher: "*", hooks: [] }] })).toThrow();
  });

  it("passes through forward-compat sections (agents/commands/skills)", () => {
    const parsed = oxagenSettingsSchema.parse({
      model: "x/y",
      agents: { reviewer: { model: "z" } },
      commands: ["./.oxagen/commands"],
    }) as Record<string, unknown>;
    expect(parsed["agents"]).toEqual({ reviewer: { model: "z" } });
    expect(parsed["commands"]).toEqual(["./.oxagen/commands"]);
  });

  it("accepts an empty document", () => {
    expect(oxagenSettingsSchema.parse({})).toEqual({});
  });
});
