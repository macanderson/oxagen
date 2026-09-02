import { describe, expect, it } from "vitest";
import { systemInstallInstructions } from "./system.install.instructions";

describe("system.install.instructions capability", () => {
  it("parses a minimal valid input for claude-code", () => {
    const parsed = systemInstallInstructions.input.parse({
      client: "claude-code",
    });
    expect(parsed.client).toBe("claude-code");
    expect(parsed.workspaceSlug).toBeUndefined();
  });

  it("parses all supported client values", () => {
    const clients = [
      "claude-code",
      "cursor",
      "claude-desktop",
      "codex",
      "vscode",
    ] as const;
    for (const client of clients) {
      const parsed = systemInstallInstructions.input.parse({ client });
      expect(parsed.client).toBe(client);
    }
  });

  it("parses input with optional workspaceSlug", () => {
    const parsed = systemInstallInstructions.input.parse({
      client: "cursor",
      workspaceSlug: "my-workspace",
    });
    expect(parsed.workspaceSlug).toBe("my-workspace");
  });

  it("rejects an unknown client value", () => {
    expect(() =>
      systemInstallInstructions.input.parse({ client: "unknown-client" }),
    ).toThrow();
  });

  it("parses a valid output with steps and render directive", () => {
    const out = systemInstallInstructions.output.parse({
      client: "claude-code",
      steps: [
        { label: "Install CLI", command: "npm install -g @oxagen/cli" },
        { label: "Authenticate" },
      ],
      render: {
        componentId: "install-instructions",
        props: { client: "claude-code", steps: [] },
      },
    });
    expect(out.client).toBe("claude-code");
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0]?.command).toBe("npm install -g @oxagen/cli");
    expect(out.steps[1]?.command).toBeUndefined();
    expect(out.render.componentId).toBe("install-instructions");
  });

  it("rejects output with empty steps array", () => {
    expect(() =>
      systemInstallInstructions.output.parse({
        client: "vscode",
        steps: [],
        render: { componentId: "install-instructions", props: {} },
      }),
    ).toThrow();
  });

  it("rejects a step with an empty label", () => {
    expect(() =>
      systemInstallInstructions.output.parse({
        client: "vscode",
        steps: [{ label: "" }],
        render: { componentId: "install-instructions", props: {} },
      }),
    ).toThrow();
  });

  it("has the expected contract metadata", () => {
    expect(systemInstallInstructions.name).toBe("get_install_instructions");
    expect(systemInstallInstructions.surfaces).toContain("api");
    expect(systemInstallInstructions.surfaces).toContain("mcp");
    expect(systemInstallInstructions.surfaces).toContain("agent");
    expect(systemInstallInstructions.sensitivity).toBe("low");
    expect(systemInstallInstructions.defaultEffect).toBe("deny");
  });
});
