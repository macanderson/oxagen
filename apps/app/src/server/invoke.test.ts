import type { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { getScope } from "@oxagen/tenancy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ContractOutputMismatch,
  FixtureWriteRefused,
  ToolInputInvalid,
  ToolNotRegistered,
} from "./errors";
import type { Viewer } from "./viewer-resolution";

const { invokeMock, getCapabilityMock, registry } = vi.hoisted(() => ({
  registry: { loaded: false },
  invokeMock:
    vi.fn<
      (
        name: string,
        input: unknown,
        ctx: Record<string, unknown>,
        opts?: unknown,
      ) => Promise<unknown>
    >(),
  getCapabilityMock: vi.fn<(name: string) => unknown>(),
}));

vi.mock("@oxagen/handlers/register", () => {
  registry.loaded = true;
  return {};
});
vi.mock("@oxagen/oxagen", () => ({
  invoke: invokeMock,
  getCapability: getCapabilityMock,
}));

import {
  invokeTool,
  setFixtureWriteAdapter,
  type ToolContract,
} from "./invoke";

// Compile-time proof that a real registered contract (zod 3.25, from
// @oxagen/oxagen) fits the structural seam the app (zod 4) calls through.
type RealContractFits = typeof agentApprovalResolve extends ToolContract<
  infer _I,
  infer _O
>
  ? true
  : false;
const realContractFits: RealContractFits = true;

const resolveApproval = {
  name: "resolve_approval",
  input: z.object({
    approvalId: z.string().min(1),
    decision: z.enum(["approved", "denied"]),
  }),
  output: z.object({ id: z.string(), status: z.enum(["approved", "denied"]) }),
};

const viewer: Viewer = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  user: { id: "u1", email: "m@acme.example", name: null, image: null },
  orgRole: "member",
  scope: {
    orgId: "6f1d2c3a-5b4e-4d10-8a01-00000000ac01",
    workspaceId: "6f1d2c3a-5b4e-4d10-8a01-00000000c001",
  },
  org: {
    id: "6f1d2c3a-5b4e-4d10-8a01-00000000ac01",
    slug: "acme",
    name: "Acme",
  },
  ws: {
    id: "6f1d2c3a-5b4e-4d10-8a01-00000000c001",
    slug: "core-platform",
    name: "Core platform",
  },
};
const input = { approvalId: "apr_1", decision: "approved" as const };

beforeEach(() => {
  invokeMock.mockReset();
  getCapabilityMock.mockReset();
  getCapabilityMock.mockReturnValue({ name: "resolve_approval" });
});
afterEach(() => {
  setFixtureWriteAdapter(null);
});

// Fixture mode runs first: the handler registry import is memoized per module,
// so "never loads the handler registry" must run before any live-path test.
describe("invokeTool: fixture mode never reaches the kernel", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
  });

  it("throws FixtureWriteRefused when no fixture write adapter is registered", async () => {
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toThrow(
      FixtureWriteRefused,
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(getCapabilityMock).not.toHaveBeenCalled();
  });

  it("never loads the handler registry", async () => {
    setFixtureWriteAdapter(() =>
      Promise.resolve({ id: "apr_1", status: "approved" }),
    );
    await invokeTool(viewer, resolveApproval, input);
    expect(registry.loaded).toBe(false);
  });

  it("records the call through the fixture adapter and parses its result", async () => {
    const adapter = vi.fn(() =>
      Promise.resolve({ id: "apr_1", status: "approved", recorded: true }),
    );
    setFixtureWriteAdapter(adapter);
    await expect(invokeTool(viewer, resolveApproval, input)).resolves.toEqual({
      id: "apr_1",
      status: "approved",
    });
    expect(adapter).toHaveBeenCalledWith({
      tool: "resolve_approval",
      input,
      userId: viewer.userId,
      scope: viewer.scope,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects input the contract rejects, before the adapter sees it", async () => {
    const adapter = vi.fn();
    setFixtureWriteAdapter(adapter);
    const bad = { approvalId: "", decision: "approved" as const };
    await expect(invokeTool(viewer, resolveApproval, bad)).rejects.toThrow(
      ToolInputInvalid,
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it("throws ContractOutputMismatch when the adapter returns the wrong shape", async () => {
    setFixtureWriteAdapter(() => Promise.resolve({ nope: true }));
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toThrow(
      ContractOutputMismatch,
    );
  });
});

describe("invokeTool: live kernel path", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "");
  });

  it("a real contract type fits the seam", () => {
    expect(realContractFits).toBe(true);
  });

  it("loads the handler registry before the first kernel call", async () => {
    invokeMock.mockImplementation(() => {
      expect(registry.loaded).toBe(true);
      return Promise.resolve({ id: "apr_1", status: "approved" });
    });
    await invokeTool(viewer, resolveApproval, input);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("invokes the kernel inside the viewer's tenant scope and returns the parsed output", async () => {
    let scopeSeen: unknown = null;
    invokeMock.mockImplementation(() => {
      scopeSeen = getScope();
      return Promise.resolve({ id: "apr_1", status: "approved", extra: 1 });
    });
    const out = await invokeTool(viewer, resolveApproval, input);
    // Parsed, not cast: the unknown key is stripped by the contract schema.
    expect(out).toEqual({ id: "apr_1", status: "approved" });
    expect(scopeSeen).toMatchObject(viewer.scope);
    expect(invokeMock).toHaveBeenCalledOnce();
    const [name, sentInput, ctx, opts] = invokeMock.mock.calls[0] ?? [];
    expect(name).toBe("resolve_approval");
    expect(sentInput).toBe(input);
    expect(ctx).toMatchObject({
      orgId: viewer.scope.orgId,
      workspaceId: viewer.scope.workspaceId,
      userId: viewer.userId,
      apiKeyId: null,
      surface: "app",
      messageId: null,
    });
    expect(ctx?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // No surface claim: api-only contracts must not be surface-denied from the app.
    expect(opts).toBeUndefined();
  });

  it("throws ContractOutputMismatch when the output does not match the contract, and never returns it", async () => {
    invokeMock.mockResolvedValue({ id: 42, status: "maybe" });
    const err = await invokeTool(viewer, resolveApproval, input).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractOutputMismatch);
    expect((err as ContractOutputMismatch).tool).toBe("resolve_approval");
    expect((err as ContractOutputMismatch).issues.length).toBeGreaterThan(0);
  });

  it("throws ContractOutputMismatch for a missing result", async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toThrow(
      ContractOutputMismatch,
    );
  });

  it("refuses a contract the kernel has not registered, before invoking", async () => {
    getCapabilityMock.mockReturnValue(undefined);
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toThrow(
      ToolNotRegistered,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("propagates a kernel error untouched", async () => {
    const denied = Object.assign(new Error("denied"), {
      name: "CapabilityError",
      code: "authz_denied",
    });
    invokeMock.mockRejectedValue(denied);
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toBe(
      denied,
    );
  });

  it("ignores a registered fixture adapter in production, even with MC_DATA=fixture", async () => {
    vi.stubEnv("MC_DATA", "fixture");
    const adapter = vi.fn();
    setFixtureWriteAdapter(adapter);
    invokeMock.mockResolvedValue({ id: "apr_1", status: "approved" });
    await invokeTool(viewer, resolveApproval, input);
    expect(adapter).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledOnce();
  });
});
