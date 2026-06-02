import { describe, it, expect } from "vitest";
import { systemInstallInstructionsHandler } from "./system.install.instructions";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { InstallClient } from "@oxagen/oxagen/contracts/system.install.instructions";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const CLIENTS: InstallClient[] = [
  "claude-code",
  "cursor",
  "claude-desktop",
  "codex",
  "vscode",
];

// ─────────────────────────────────────────────────────────────────────────────

describe("systemInstallInstructionsHandler", () => {
  it("returns steps and a render directive for every supported client", async () => {
    for (const client of CLIENTS) {
      const result = await systemInstallInstructionsHandler({ client }, CTX);
      expect(result.client).toBe(client);
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.render.componentId).toBe("install-instructions");
      expect(result.render.props["client"]).toBe(client);
      expect(Array.isArray(result.render.props["steps"])).toBe(true);
    }
  });

  it("every step has a non-empty label", async () => {
    for (const client of CLIENTS) {
      const result = await systemInstallInstructionsHandler({ client }, CTX);
      for (const step of result.steps) {
        expect(step.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("at least one step per client includes a command", async () => {
    for (const client of CLIENTS) {
      const result = await systemInstallInstructionsHandler({ client }, CTX);
      const hasCommand = result.steps.some((s) => typeof s.command === "string" && s.command.length > 0);
      expect(hasCommand).toBe(true);
    }
  });

  it("includes the production API URL in commands", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "claude-code" },
      CTX,
    );
    const allCommands = result.steps
      .filter((s) => s.command)
      .map((s) => s.command!)
      .join("\n");
    expect(allCommands).toContain("oxagen-v2-api.vercel.app");
  });

  it("interpolates the workspaceSlug when provided", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "claude-code", workspaceSlug: "my-ws" },
      CTX,
    );
    const allCommands = result.steps
      .filter((s) => s.command)
      .map((s) => s.command!)
      .join("\n");
    expect(allCommands).toContain("my-ws");
  });

  it("uses a placeholder when workspaceSlug is not provided", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "cursor" },
      CTX,
    );
    const allCommands = result.steps
      .filter((s) => s.command)
      .map((s) => s.command!)
      .join("\n");
    expect(allCommands).toContain("<your-workspace-slug>");
  });
});
