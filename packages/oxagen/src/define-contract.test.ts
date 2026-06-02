// define-contract.test.ts — unit tests for the defineContract() enforcement boundary.
// OXA-1390, Phase 3.
//
// The IAM runtime (checkIAM, createAccessRequest) is mocked via setIAMRuntime()
// so no database or ClickHouse connection is needed.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  defineContract,
  setIAMRuntime,
  clearIAMRuntime,
  isDenial,
  type IAMCheckFn,
  type CreateAccessRequestFn,
} from "./define-contract";
import { clearRegistryForTests } from "./registry";
import { clearHandlersForTests } from "./kernel";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const RAW_CTX = {
  orgId: "org_aaa",
  workspaceId: "ws_bbb",
  userId: "u_ccc",
  apiKeyId: null,
  requestId: "req_ddd",
  surface: "api" as const,
  messageId: null,
};

const INPUT_SCHEMA = z.object({ name: z.string() });
const OUTPUT_SCHEMA = z.object({ result: z.string() });

function makeSpec(handlerFn: (ctx: object, input: object) => Promise<{ result: string }> = async (_ctx, input) => {
  const i = input as { name: string };
  return { result: i.name };
}) {
  return {
    id: `test.capability.${Math.random().toString(36).slice(2)}`,
    domain: "test",
    description: "Test capability",
    mode: "sync" as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "deny" as const,
    defaultRoles: { org: {}, workspace: {} },
    input: INPUT_SCHEMA,
    output: OUTPUT_SCHEMA,
    handler: handlerFn as Parameters<typeof defineContract>[0]["handler"],
  };
}

function mockIAMRuntime(
  outcome: "allow" | "deny" | "pending_approval",
  extras: { reason?: string; requestId?: string } = {},
) {
  const checkIAM: IAMCheckFn = vi.fn().mockResolvedValue({
    outcome,
    reason: extras.reason ?? (outcome === "allow" ? undefined : "no_grant"),
    principal: outcome === "allow" ? { id: "prn_1", kind: "human", orgId: "org_aaa", workspaceId: "ws_bbb" } : null,
  });
  const createAccessRequest: CreateAccessRequestFn = vi.fn().mockResolvedValue(extras.requestId ?? "arq_xyz");
  setIAMRuntime({ checkIAM, createAccessRequest });
  return { checkIAM, createAccessRequest };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearRegistryForTests();
  clearHandlersForTests();
  clearIAMRuntime();
});

afterEach(() => {
  clearIAMRuntime();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("defineContract — structure", () => {
  it("returns an object with id and metadata — NOT handler", () => {
    const spec = makeSpec();
    const contract = defineContract(spec);
    expect(contract.id).toBe(spec.id);
    expect(contract.metadata).toBeDefined();
    expect(contract.metadata.name).toBe(spec.id);
    // The handler must NOT be accessible on the returned object.
    expect(Object.keys(contract)).not.toContain("handler");
    expect((contract as unknown as Record<string, unknown>)["handler"]).toBeUndefined();
  });

  it("metadata contains sensitivity and defaultEffect", () => {
    const spec = makeSpec();
    const contract = defineContract(spec);
    expect(contract.metadata.sensitivity).toBe("low");
    expect(contract.metadata.defaultEffect).toBe("deny");
  });

  it("registerCapability is called during defineContract construction (getCapability returns metadata)", async () => {
    const { getCapability } = await import("./registry");
    const spec = makeSpec();
    defineContract(spec);
    const cap = getCapability(spec.id);
    expect(cap).toBeDefined();
    expect(cap?.name).toBe(spec.id);
  });
});

describe("defineContract — allow path", () => {
  it("invoke calls the handler when the resolver returns allow", async () => {
    const handlerFn = vi.fn().mockResolvedValue({ result: "hello" });
    const spec = makeSpec(handlerFn);
    const { checkIAM } = mockIAMRuntime("allow");
    const contract = defineContract(spec);

    const result = await contract.invoke(RAW_CTX, { name: "hello" });

    expect(isDenial(result)).toBe(false);
    expect(result).toEqual({ result: "hello" });
    expect(handlerFn).toHaveBeenCalledOnce();
    expect(checkIAM).toHaveBeenCalledOnce();
  });

  it("handler receives the CheckedContext with principal from IAM", async () => {
    let capturedCtx: unknown;
    const handlerFn = vi.fn(async (ctx: unknown, _input: unknown) => {
      capturedCtx = ctx;
      return { result: "ok" };
    });
    const spec = makeSpec(handlerFn);
    mockIAMRuntime("allow");
    const contract = defineContract(spec);

    await contract.invoke(RAW_CTX, { name: "test" });

    expect(capturedCtx).toBeDefined();
    const ctx = capturedCtx as Record<string, unknown>;
    expect(ctx["orgId"]).toBe(RAW_CTX.orgId);
    expect(ctx["principal"]).not.toBeNull();
    expect((ctx["principal"] as Record<string, unknown>)["kind"]).toBe("human");
  });
});

describe("defineContract — deny path", () => {
  it("invoke does NOT call the handler when resolver returns deny", async () => {
    const handlerFn = vi.fn();
    const spec = makeSpec(handlerFn);
    mockIAMRuntime("deny");
    const contract = defineContract(spec);

    const result = await contract.invoke(RAW_CTX, { name: "hello" });

    expect(isDenial(result)).toBe(true);
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("deny result has __capabilityDenied true and correct outcome", async () => {
    const spec = makeSpec();
    mockIAMRuntime("deny", { reason: "no_grant" });
    const contract = defineContract(spec);

    const result = await contract.invoke(RAW_CTX, { name: "hello" });

    expect(isDenial(result)).toBe(true);
    if (isDenial(result)) {
      expect(result.outcome).toBe("deny");
      expect(result.reason).toBe("no_grant");
    }
  });
});

describe("defineContract — pending_approval path", () => {
  it("invoke returns DenialResponse with pending_approval and requestId", async () => {
    const handlerFn = vi.fn();
    const spec = makeSpec(handlerFn);
    mockIAMRuntime("pending_approval", { requestId: "arq_abc" });
    const contract = defineContract(spec);

    const result = await contract.invoke(RAW_CTX, { name: "hello" });

    expect(isDenial(result)).toBe(true);
    if (isDenial(result)) {
      expect(result.outcome).toBe("pending_approval");
      // mockIAMRuntime({ requestId: "arq_abc" }) sets createAccessRequest to return "arq_abc".
      expect(result.requestId).toBe("arq_abc");
    }
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("createAccessRequest is called when outcome is pending_approval", async () => {
    const spec = makeSpec();
    const { createAccessRequest } = mockIAMRuntime("pending_approval");
    const contract = defineContract(spec);

    await contract.invoke(RAW_CTX, { name: "hello" });

    expect(createAccessRequest).toHaveBeenCalledOnce();
    expect(createAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({ capability: spec.id }),
    );
  });
});

describe("defineContract — input validation", () => {
  it("invoke rejects with an error when input fails the Zod schema", async () => {
    const spec = makeSpec();
    mockIAMRuntime("allow");
    const contract = defineContract(spec);

    await expect(contract.invoke(RAW_CTX, { name: 42 })).rejects.toThrow(/Input validation failed/);
  });

  it("IAM check is NOT called when input validation fails", async () => {
    const spec = makeSpec();
    const { checkIAM } = mockIAMRuntime("allow");
    const contract = defineContract(spec);

    await expect(contract.invoke(RAW_CTX, { wrongField: true })).rejects.toThrow();

    expect(checkIAM).not.toHaveBeenCalled();
  });
});

describe("defineContract — output validation", () => {
  it("invoke rejects with an error when handler returns wrong output shape", async () => {
    const badHandler = vi.fn().mockResolvedValue({ wrong: "shape" });
    const spec = makeSpec(badHandler as Parameters<typeof makeSpec>[0]);
    mockIAMRuntime("allow");
    const contract = defineContract(spec);

    await expect(contract.invoke(RAW_CTX, { name: "test" })).rejects.toThrow(
      /Output validation failed/,
    );
  });
});

describe("defineContract — IAM runtime not registered", () => {
  it("logs a warning and allows when IAM runtime is not registered", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handlerFn = vi.fn().mockResolvedValue({ result: "ok" });
    const spec = makeSpec(handlerFn);
    // Do NOT call setIAMRuntime — runtime is null.
    const contract = defineContract(spec);

    const result = await contract.invoke(RAW_CTX, { name: "test" });

    expect(isDenial(result)).toBe(false);
    expect(result).toEqual({ result: "ok" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/IAM runtime not registered/));

    warnSpy.mockRestore();
  });
});
