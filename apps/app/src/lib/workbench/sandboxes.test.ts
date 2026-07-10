import { describe, it, expect, vi, beforeEach } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke }));

import {
  listSandboxes,
  startSandbox,
  runSandboxCommand,
  stopSandbox,
  renameSandbox,
  isSandboxUnavailable,
} from "./sandboxes";

const CTX = {
  orgId: "o1",
  workspaceId: "w1",
  userId: "u1",
  apiKeyId: null,
  requestId: "r1",
  surface: "app" as const,
  messageId: null,
};

beforeEach(() => {
  invoke.mockReset();
});

describe("lib/workbench/sandboxes", () => {
  it("listSandboxes calls list_sandboxes with surface agent and returns the array", async () => {
    invoke.mockResolvedValue({ sandboxes: [{ sessionId: "sbx_1" }] });
    const out = await listSandboxes(CTX, { status: "running", limit: 10 });
    expect(invoke).toHaveBeenCalledWith(
      "list_sandboxes",
      { status: "running", limit: 10 },
      CTX,
      { surface: "agent" },
    );
    expect(out).toEqual([{ sessionId: "sbx_1" }]);
  });

  it("listSandboxes forwards activeOnly for the live-reconciled, truthful view", async () => {
    invoke.mockResolvedValue({ sandboxes: [] });
    await listSandboxes(CTX, { activeOnly: true });
    expect(invoke).toHaveBeenCalledWith(
      "list_sandboxes",
      { activeOnly: true },
      CTX,
      { surface: "agent" },
    );
  });

  it("startSandbox forwards image/sessionKey/setupCmd", async () => {
    invoke.mockResolvedValue({ sessionId: "sbx_2", reused: false });
    await startSandbox(CTX, {
      image: "agent",
      sessionKey: "k1",
      setupCmd: "echo hi",
      network: "allow",
    });
    expect(invoke).toHaveBeenCalledWith(
      "start_sandbox",
      {
        image: "agent",
        sessionKey: "k1",
        setupCmd: "echo hi",
        network: "allow",
      },
      CTX,
      { surface: "agent" },
    );
  });

  it("startSandbox forwards repos to clone", async () => {
    invoke.mockResolvedValue({ sessionId: "sbx_3", reused: false });
    const repos = [{ owner: "acme", repo: "api", branch: "main" }];
    await startSandbox(CTX, {
      image: "agent",
      sessionKey: "k2",
      repos,
      network: "allow",
    });
    expect(invoke).toHaveBeenCalledWith(
      "start_sandbox",
      { image: "agent", sessionKey: "k2", repos, network: "allow" },
      CTX,
      { surface: "agent" },
    );
  });

  it("renameSandbox calls rename_sandbox with the session id and label", async () => {
    invoke.mockResolvedValue({ sessionId: "sbx_2", label: "New name" });
    const out = await renameSandbox(CTX, {
      sessionId: "sbx_2",
      label: "New name",
    });
    expect(invoke).toHaveBeenCalledWith(
      "rename_sandbox",
      { sessionId: "sbx_2", label: "New name" },
      CTX,
      { surface: "agent" },
    );
    expect(out).toEqual({ sessionId: "sbx_2", label: "New name" });
  });

  it("runSandboxCommand calls run_sandbox_command", async () => {
    invoke.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    await runSandboxCommand(CTX, { sessionId: "sbx_2", command: "ls" });
    expect(invoke).toHaveBeenCalledWith(
      "run_sandbox_command",
      { sessionId: "sbx_2", command: "ls" },
      CTX,
      { surface: "agent" },
    );
  });

  it("stopSandbox calls stop_sandbox", async () => {
    invoke.mockResolvedValue({ stopped: true });
    const out = await stopSandbox(CTX, "sbx_2");
    expect(invoke).toHaveBeenCalledWith(
      "stop_sandbox",
      { sessionId: "sbx_2" },
      CTX,
      { surface: "agent" },
    );
    expect(out.stopped).toBe(true);
  });

  it("isSandboxUnavailable recognises the driver-off error", () => {
    expect(
      isSandboxUnavailable(
        new Error("Durable sandbox sessions are not available."),
      ),
    ).toBe(true);
    expect(isSandboxUnavailable(new Error("Set SANDBOX_ENABLED=true"))).toBe(
      true,
    );
    expect(isSandboxUnavailable(new Error("some other failure"))).toBe(false);
    expect(isSandboxUnavailable(null)).toBe(false);
  });
});
