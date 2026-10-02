// studio-capabilities.handlers.test.ts: handler invocation tests for the
// Studio tools that serve MCP Studio's app screens (#4678):
// set_mcp_credential, list_studio_findings, draft_studio_description,
// try_studio_tool, and run_studio_selection.
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext`.
// Each test asserts buildContext was called, invoke received the contract
// name, the args, and { surface: "mcp" }, and the output passed the
// contract's output schema on the way back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import setMcpCredential, {
  metadata as setMcpCredentialMeta,
  schema as setMcpCredentialSchema,
} from "./tool.studio.credential.set";
import listStudioFindings, {
  metadata as listStudioFindingsMeta,
  schema as listStudioFindingsSchema,
} from "./tool.studio.findings.list";
import draftStudioDescription, {
  metadata as draftStudioDescriptionMeta,
  schema as draftStudioDescriptionSchema,
} from "./tool.studio.description.draft";
import runStudioSelection, {
  metadata as runStudioSelectionMeta,
  schema as runStudioSelectionSchema,
} from "./tool.studio.selection.run";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("set_mcp_credential", () => {
  it("carries the contract's name and marks a replace destructive", () => {
    expect(setMcpCredentialMeta.name).toBe("set_mcp_credential");
    expect(setMcpCredentialMeta.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(Object.keys(setMcpCredentialSchema).sort()).toEqual([
      "clientId",
      "clientSecret",
      "kind",
      "name",
      "secret",
    ]);
  });

  it("invokes with the contract name and returns the name and reference only", async () => {
    const output = { name: "stripe-live", reference: "oxagen:credential/stripe-live", created: true };
    mocks.invoke.mockResolvedValue(output);
    const args = {
      name: "stripe-live",
      kind: "secret" as const,
      secret: "sk_test_fake_1",
      clientId: undefined,
      clientSecret: undefined,
    };

    const result = await setMcpCredential(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("set_mcp_credential", args, fakeCtx, { surface: "mcp" });
    expect(result).toEqual(output);
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ name: "stripe-live" });
    await expect(
      setMcpCredential({
        name: "stripe-live",
        kind: "secret",
        secret: "sk_test_fake_1",
        clientId: undefined,
        clientSecret: undefined,
      }),
    ).rejects.toThrow();
  });
});

describe("list_studio_findings", () => {
  it("carries the contract's name and reads only", () => {
    expect(listStudioFindingsMeta.name).toBe("list_studio_findings");
    expect(listStudioFindingsMeta.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(Object.keys(listStudioFindingsSchema)).toEqual(["server"]);
  });

  it("invokes with the contract name and returns the findings", async () => {
    const output = {
      server: "billing",
      basis: "published",
      revision: null,
      tokens: { definitions: 612, budget: 8000 },
      findings: [
        {
          rule: "unknown_credential",
          level: "error",
          tool: null,
          field: "auth.credential",
          message: "auth.credential names oxagen:credential/billing-oauth-client, and the organization has no credential by that name, so every call would fail.",
          fix: "Add oxagen:credential/billing-oauth-client in Oxagen, or set auth.credential to a credential the organization has.",
        },
      ],
    };
    mocks.invoke.mockResolvedValue(output);

    const result = await listStudioFindings({ server: "billing" });

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("list_studio_findings", { server: "billing" }, fakeCtx, {
      surface: "mcp",
    });
    expect(result).toEqual(output);
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ server: "billing", basis: "branch" });
    await expect(listStudioFindings({ server: "billing" })).rejects.toThrow();
  });
});

describe("draft_studio_description", () => {
  it("carries the contract's name, saves nothing, and is not idempotent", () => {
    expect(draftStudioDescriptionMeta.name).toBe("draft_studio_description");
    expect(draftStudioDescriptionMeta.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(Object.keys(draftStudioDescriptionSchema)).toEqual(["server", "tool"]);
  });

  it("invokes with the contract name and returns the suggestion", async () => {
    const output = {
      server: "billing",
      tool: "list_charges",
      description: "List a customer's charges, newest first. Amounts are in cents.",
    };
    mocks.invoke.mockResolvedValue(output);

    const result = await draftStudioDescription({ server: "billing", tool: "list_charges" });

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "draft_studio_description",
      { server: "billing", tool: "list_charges" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(output);
  });

  it("refuses an empty suggestion", async () => {
    mocks.invoke.mockResolvedValue({ server: "billing", tool: "list_charges", description: "" });
    await expect(draftStudioDescription({ server: "billing", tool: "list_charges" })).rejects.toThrow();
  });
});

describe("run_studio_selection", () => {
  it("carries the contract's name, saves nothing, and is not idempotent", () => {
    expect(runStudioSelectionMeta.name).toBe("run_studio_selection");
    expect(runStudioSelectionMeta.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(Object.keys(runStudioSelectionSchema)).toEqual(["server"]);
  });

  it("invokes with the contract name and returns the run's hits and misses", async () => {
    const output = {
      server: "billing",
      basis: "published",
      revision: null,
      model: "fast-model",
      counts: { total: 2, hits: 1, misses: 1, malformed: 0, skipped: 0, errors: 0, notRun: 0 },
      cases: [
        {
          line: 1,
          task: "Refund $40 of charge ch_3P9.",
          expected: "billing__create_refund",
          status: "hit",
          chosen: "billing__create_refund",
        },
        {
          line: 2,
          task: "Write a haiku about invoices.",
          expected: null,
          status: "miss",
          chosen: "billing__list_charges",
        },
      ],
      stopped: null,
    };
    mocks.invoke.mockResolvedValue(output);

    const result = await runStudioSelection({ server: "billing" });

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "run_studio_selection",
      { server: "billing" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(output);
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ server: "billing", basis: "published", hits: 2 });
    await expect(runStudioSelection({ server: "billing" })).rejects.toThrow();
  });
});
