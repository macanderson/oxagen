import { describe, it, expect } from "vitest";
import { systemInstallInstructionsHandler } from "./system.install.instructions";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { InstallClient } from "@oxagen/oxagen/contracts/system.install.instructions";

// ── fixtures ──────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

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
      const hasCommand = result.steps.some(
        (s) => typeof s.command === "string" && s.command.length > 0,
      );
      expect(hasCommand).toBe(true);
    }
  });

  it("includes the production MCP connect URL in commands", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "claude-code" },
      CTX,
    );
    const allCommands = result.steps
      .filter((s) => s.command)
      .map((s) => s.command!)
      .join("\n");
    // MCP is served by the xmcp app (oxagen-v2-mcp) at /mcp, NOT the REST API host.
    expect(allCommands).toContain("mcp.oxagen.sh/mcp");
    expect(allCommands).not.toContain("api.oxagen.sh/mcp");
  });

  it("includes the Authorization header in the claude-code connect command", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "claude-code" },
      CTX,
    );
    // The MCP server is API-key scoped; the `claude mcp add` command must carry
    // the bearer token or every connection 401s.
    const connectStep = result.steps.find(
      (s) =>
        typeof s.command === "string" && s.command.includes("claude mcp add"),
    );
    expect(connectStep?.command).toContain(
      '--header "Authorization: Bearer $OXAGEN_API_KEY"',
    );
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
    // claude-code's `oxagen workspace use <slug>` step still surfaces the slug;
    // the MCP connect URL itself is workspace-scoped by the API key, not the path.
    const result = await systemInstallInstructionsHandler(
      { client: "claude-code" },
      CTX,
    );
    const allCommands = result.steps
      .filter((s) => s.command)
      .map((s) => s.command!)
      .join("\n");
    expect(allCommands).toContain("<your-workspace-slug>");
  });

  // ── error path ────────────────────────────────────────────────────────────

  it("throws TypeError when an unsupported client bypasses Zod validation", async () => {
    // The Zod contract enum validates client at the boundary, but the handler
    // does a direct map lookup: STEP_BUILDERS[input.client]. An unknown client
    // key returns undefined, and calling undefined() throws a TypeError.
    // This test documents the handler's behaviour when called without schema
    // validation (e.g., direct unit-test invocation or contract bypass).
    await expect(
      systemInstallInstructionsHandler(
        // @ts-expect-error — intentionally passing an unsupported client
        { client: "unknown-client" },
        CTX,
      ),
    ).rejects.toThrow(TypeError);
  });
});
