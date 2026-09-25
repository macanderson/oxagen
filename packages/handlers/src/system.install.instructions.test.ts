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

  // The capability takes no platform, so a step's command has to run on
  // macOS, Linux, and Windows alike. `open` exists only on macOS: Linux
  // answers `open: command not found`, and Windows has no such command.
  it("never hands a reader the macOS-only open command", async () => {
    for (const client of CLIENTS) {
      const result = await systemInstallInstructionsHandler({ client }, CTX);
      for (const step of result.steps) {
        expect(step.command ?? "").not.toMatch(/^\s*open\s/);
      }
    }
  });

  it("names the config file for every platform where the command used to open it", async () => {
    const cursor = await systemInstallInstructionsHandler(
      { client: "cursor" },
      CTX,
    );
    const cursorText = cursor.steps.map((s) => s.label).join("\n");
    expect(cursorText).toContain("~/.cursor/mcp.json");
    expect(cursorText).toContain("%USERPROFILE%\\.cursor\\mcp.json");
    const desktop = await systemInstallInstructionsHandler(
      { client: "claude-desktop" },
      CTX,
    );
    const desktopText = desktop.steps.map((s) => s.label).join("\n");
    expect(desktopText).toContain(
      "~/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(desktopText).toContain(
      "%APPDATA%\\Claude\\claude_desktop_config.json",
    );
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

  it("passes the claude-code URL positionally — `claude mcp add` has no --url flag", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "claude-code" },
      CTX,
    );
    const connect = result.steps.find((s) =>
      s.command?.includes("claude mcp add"),
    )?.command;
    expect(connect).toMatch(
      /^claude mcp add --transport http oxagen "https:\/\/[^"]+\/mcp" --header /,
    );
    expect(connect).not.toContain("--url");
  });

  it("configures codex through `codex mcp add`, never a codex.yaml", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "codex" },
      CTX,
    );
    const text = result.steps
      .map((s) => `${s.label}\n${s.command ?? ""}`)
      .join("\n");
    expect(text).toMatch(
      /codex mcp add oxagen --url "https:\/\/[^"]+\/mcp" --bearer-token-env-var OXAGEN_API_KEY/,
    );
    expect(text).toContain("codex mcp list");
    expect(text).not.toContain("codex.yaml");
    expect(text).not.toContain("codex tools list");
  });

  it("bridges claude-desktop through mcp-remote — its config file cannot hold a remote url", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "claude-desktop" },
      CTX,
    );
    const entryStep = result.steps.find((s) =>
      s.command?.trimStart().startsWith("{"),
    );
    const server = JSON.parse(entryStep!.command!).mcpServers.oxagen;
    expect(server.url).toBeUndefined();
    expect(server.command).toBe("npx");
    expect(server.args).toContain("mcp-remote");
    expect(server.args.some((a: string) => a.endsWith("/mcp"))).toBe(true);
    expect(server.env.OXAGEN_AUTH_HEADER).toMatch(/^Bearer /);
  });

  it("points every client at the API-key page — the key carries org+workspace scope", async () => {
    for (const client of CLIENTS) {
      const result = await systemInstallInstructionsHandler({ client }, CTX);
      const allCommands = result.steps
        .filter((s) => s.command)
        .map((s) => s.command!)
        .join("\n");
      expect(allCommands).toContain("/developer/tokens");
    }
  });

  it("never instructs the user to install a coding agent or a runtime", async () => {
    // ADR-043: Oxagen governs agents, it does not run them. These instructions
    // connect an EXTERNAL client to the governed MCP gateway; they must never
    // describe installing a sandbox, a worker, or an Oxagen-hosted coding agent.
    for (const client of CLIENTS) {
      const result = await systemInstallInstructionsHandler({ client }, CTX);
      const text = result.steps
        .map((s) => `${s.label}\n${s.command ?? ""}`)
        .join("\n")
        .toLowerCase();
      expect(text).not.toContain("sandbox");
      expect(text).not.toContain("skill");
      expect(text).not.toContain("oxagen workspace use");
    }
  });

  // ── the wrap with a one-time enrollment token (#2967) ─────────────────────

  it("answers the wrap steps for claude-code, codex, and cursor when handed an enrollment token", async () => {
    const enrollmentToken = "oxe_1time_0123456789abcdefghjkmnpqrs";
    for (const client of ["claude-code", "codex", "cursor"] as const) {
      const result = await systemInstallInstructionsHandler(
        { client, enrollmentToken },
        CTX,
      );
      const commands = result.steps.map((s) => s.command ?? "");
      expect(commands).toContain(
        `oxagen agent enroll --token ${enrollmentToken} --harness ${client}`,
      );
      // The wrap replaces the MCP steps: no API-key page, no `mcp add`.
      expect(commands.join("\n")).not.toContain("mcp add");
      expect(commands.join("\n")).not.toContain("/developer/tokens");
      expect(result.render.props["steps"]).toEqual(result.steps);
    }
  });

  it("starts the wrapped session with each harness's own binary", async () => {
    const enrollmentToken = "oxe_1time_0123456789abcdefghjkmnpqrs";
    const binaries = {
      "claude-code": "claude",
      codex: "codex",
      // Cursor's CLI is `cursor-agent`; a bare `cursor` opens the IDE.
      cursor: "cursor-agent",
    } as const;
    for (const [client, binary] of Object.entries(binaries)) {
      const result = await systemInstallInstructionsHandler(
        { client: client as keyof typeof binaries, enrollmentToken },
        CTX,
      );
      expect(result.steps.at(-1)?.command).toBe(binary);
    }
  });

  it("configures cursor through ~/.cursor/mcp.json with a bearer header", async () => {
    const result = await systemInstallInstructionsHandler(
      { client: "cursor" },
      CTX,
    );
    const text = result.steps
      .map((s) => `${s.label}\n${s.command ?? ""}`)
      .join("\n");
    expect(text).toContain("~/.cursor/mcp.json");
    const entryStep = result.steps.find((s) =>
      s.command?.trimStart().startsWith("{"),
    );
    const server = JSON.parse(entryStep!.command!).mcpServers.oxagen;
    expect(server.url).toMatch(/^https:\/\/.+\/mcp$/);
    // JSON expands nothing, so the key is a placeholder, never `$OXAGEN_API_KEY`.
    expect(server.headers.Authorization).toBe("Bearer <your-api-key>");
  });

  it("ignores the token for a client that has no wrap", async () => {
    const withToken = await systemInstallInstructionsHandler(
      {
        client: "vscode",
        enrollmentToken: "oxe_1time_0123456789abcdefghjkmnpqrs",
      },
      CTX,
    );
    const without = await systemInstallInstructionsHandler(
      { client: "vscode" },
      CTX,
    );
    expect(withToken.steps).toEqual(without.steps);
    expect(JSON.stringify(withToken)).not.toContain("oxe_1time_");
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
