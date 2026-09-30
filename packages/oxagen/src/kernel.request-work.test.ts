import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRequestWork } from "@oxagen/config/request-work";
import { clearRegistryForTests, registerCapability } from "./registry";
import { clearHandlersForTests, invoke, registerHandler } from "./kernel";
import type { CapabilityContext } from "./types";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u", apiKeyId: null, requestId: "r", surface: "mcp", messageId: null,
};

function register() {
  registerCapability({
    name: "test_request_work", domain: "test", description: "Test request work.",
    mode: "sync", surfaces: ["mcp"], layers: ["unit"], sensitivity: "low",
    defaultEffect: "allow", defaultRoles: { org: {}, workspace: {} },
    input: z.object({}), output: z.object({}),
  });
}

afterEach(() => {
  clearRegistryForTests();
  clearHandlersForTests();
});

describe("kernel request work", () => {
  it("retains an HTTP reservation until a disconnected invocation completes", async () => {
    register();
    let finish: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    registerHandler("test_request_work", async () => async () => {
      started();
      await waiting;
      return {};
    });
    const release = vi.fn();
    const work = createRequestWork(release);
    const result = work.run(() => invoke("test_request_work", {}, ctx));
    await running;
    work.close();
    expect(release).not.toHaveBeenCalled();
    finish();
    await expect(result).resolves.toEqual({});
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not start an invocation after the request reservation is gone", async () => {
    register();
    const handler = vi.fn(async () => ({}));
    registerHandler("test_request_work", async () => handler);
    const work = createRequestWork(vi.fn());
    work.close();
    await expect(work.run(() => invoke("test_request_work", {}, ctx))).rejects.toThrow("request has ended");
    expect(handler).not.toHaveBeenCalled();
  });
});
