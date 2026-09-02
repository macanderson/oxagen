import { describe, it, expect } from "vitest";
import {
  oxagenSettingsSchema,
  permissionsSchema,
  hooksSchema,
} from "../schema.js";

describe("oxagenSettingsSchema", () => {
  it("parses a full settings document", () => {
    const parsed = oxagenSettingsSchema.parse({
      model: "anthropic/claude-sonnet-5",
      apiUrl: "https://api.oxagen.sh",
      env: { FOO: "bar" },
      permissions: {
        defaultMode: "default",
        deny: ["Bash(rm -rf*)"],
        allow: ["Bash(git*)"],
      },
      hooks: {
        PreToolUse: [
          { matcher: "bash", hooks: [{ type: "command", command: "echo hi" }] },
        ],
      },
      mcpServers: {
        github: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "server-github"],
        },
      },
      toolVisibility: { github: { include: ["create_*"] } },
    });
    expect(parsed.model).toBe("anthropic/claude-sonnet-5");
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
    expect(() =>
      hooksSchema.parse({ PreToolUse: [{ matcher: "*", hooks: [] }] }),
    ).toThrow();
  });

  it("passes through forward-compat sections (commands/skills)", () => {
    const parsed = oxagenSettingsSchema.parse({
      model: "x/y",
      commands: ["./.oxagen/commands"],
      skills: ["./.oxagen/skills"],
    }) as Record<string, unknown>;
    expect(parsed["commands"]).toEqual(["./.oxagen/commands"]);
    expect(parsed["skills"]).toEqual(["./.oxagen/skills"]);
  });

  it("validates inline agent definitions (prompt required)", () => {
    const parsed = oxagenSettingsSchema.parse({
      agents: {
        reviewer: {
          description: "d",
          prompt: "You review.",
          tools: ["Read"],
          model: "z",
        },
      },
    });
    expect(parsed.agents?.reviewer?.prompt).toBe("You review.");
    expect(() =>
      oxagenSettingsSchema.parse({ agents: { bad: { model: "z" } } }),
    ).toThrow();
  });

  it("accepts per-agent skills and mcpServers on an inline agent", () => {
    const parsed = oxagenSettingsSchema.parse({
      agents: {
        reviewer: {
          prompt: "You review.",
          skills: ["reviewer"],
          mcpServers: ["github"],
        },
      },
    });
    expect(parsed.agents?.reviewer?.skills).toEqual(["reviewer"]);
    expect(parsed.agents?.reviewer?.mcpServers).toEqual(["github"]);
  });

  it("accepts an empty document", () => {
    expect(oxagenSettingsSchema.parse({})).toEqual({});
  });

  it("parses the per-function model keys", () => {
    const parsed = oxagenSettingsSchema.parse({
      model: "anthropic/claude-sonnet-5",
      workerModel: "anthropic/claude-fable-5",
      judgeModel: "openai/gpt-5.5-pro",
      triageModel: "anthropic/claude-haiku-4.5",
    });
    expect(parsed.workerModel).toBe("anthropic/claude-fable-5");
    expect(parsed.judgeModel).toBe("openai/gpt-5.5-pro");
    expect(parsed.triageModel).toBe("anthropic/claude-haiku-4.5");
  });

  it("parses confirmScope as an optional boolean", () => {
    const result = oxagenSettingsSchema.safeParse({ confirmScope: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.confirmScope).toBe(true);

    // Absent entirely still parses fine — the field is optional.
    const withoutIt = oxagenSettingsSchema.safeParse({});
    expect(withoutIt.success).toBe(true);
    if (withoutIt.success) expect(withoutIt.data.confirmScope).toBeUndefined();
  });

  it("rejects a non-boolean confirmScope", () => {
    expect(
      oxagenSettingsSchema.safeParse({ confirmScope: "true" }).success,
    ).toBe(false);
  });
});
