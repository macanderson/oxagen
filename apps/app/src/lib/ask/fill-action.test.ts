/**
 * fill-action.test.ts — unit tests for fillFormAction server action.
 *
 * Covers:
 *   (a) Happy path — kernel.invoke returns diffs, action maps them to FormFillResult
 *   (b) kernel.invoke throws — action returns noopResult (regression for the silent-catch fix)
 *   (c) Session failure — action returns noopResult
 *
 * Mock seam: `@oxagen/oxagen` → `invoke`. The action routes through
 * kernel.invoke() (not formFillHandler directly) to enforce IAM + audit.
 * Mocking the handler registry is unnecessary — we mock at the invoke() boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  resolveWorkspace: vi.fn(),
}));

// The action calls invoke() from @oxagen/oxagen — this is the correct seam.
vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { fillFormAction, type FillFormActionInput } from "./fill-action.js";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";
import { logger } from "@oxagen/handlers/logger";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseInput: FillFormActionInput = {
  spec: {
    formId: "create-project",
    title: "Create project",
    fields: [
      { name: "name", label: "Name", type: "text", current: "old name" },
      { name: "description", label: "Description", type: "textarea", current: "" },
    ],
  },
  instruction: "Fill in the project name as 'My Project'",
  context: {
    orgSlug: "acme",
    workspaceSlug: "prod",
    route: "/acme/prod/knowledge",
  },
};

const mockSession = { user: { id: "user-123" } };
const mockOrg = { id: "org-abc", publicId: "pub-org-abc", name: "Acme", slug: "acme" };
const mockWorkspace = { id: "ws-xyz", publicId: "pub-ws-xyz", orgId: "org-abc", name: "Production", slug: "prod" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fillFormAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
    vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
    vi.mocked(resolveWorkspace).mockResolvedValue(mockWorkspace as never);
  });

  // (a) Happy path
  it("maps handler diffs to FormFillResult on success", async () => {
    vi.mocked(invoke).mockResolvedValue({
      fields: [
        { name: "name", current: "old name", proposed: "My Project", changed: true, reason: "Instruction says so" },
        { name: "description", current: "", proposed: "", changed: false },
      ],
    });

    const result = await fillFormAction(baseInput);

    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toEqual({
      name: "name",
      current: "old name",
      proposed: "My Project",
      changed: true,
      reason: "Instruction says so",
    });
    expect(result.fields[1]).toEqual({
      name: "description",
      current: "",
      proposed: "",
      changed: false,
    });
  });

  it("invokes the capability with the correct name, input, and ctx", async () => {
    vi.mocked(invoke).mockResolvedValue({ fields: [] });

    await fillFormAction(baseInput);

    expect(invoke).toHaveBeenCalledOnce();
    const [capabilityName, capInput, ctx, opts] = vi.mocked(invoke).mock.calls[0]!;

    // Capability name
    expect(capabilityName).toBe("form.fill");

    // Context carries correct tenant + surface info
    expect(ctx.orgId).toBe("org-abc");
    expect(ctx.workspaceId).toBe("ws-xyz");
    expect(ctx.userId).toBe("user-123");
    expect(ctx.surface).toBe("app");
    expect(ctx.apiKeyId).toBeNull();
    expect(ctx.messageId).toBeNull();
    expect(typeof ctx.requestId).toBe("string");

    // Input carries the correct route and instruction
    expect((capInput as { route: string }).route).toBe("/acme/prod/knowledge");
    expect((capInput as { instruction: string }).instruction).toBe(baseInput.instruction);

    // Options mark the dispatch as originating from the agent surface
    expect(opts).toEqual({ surface: "agent" });
  });

  it("omits workspaceId when workspaceSlug is absent", async () => {
    vi.mocked(invoke).mockResolvedValue({ fields: [] });

    const inputNoWs: FillFormActionInput = {
      ...baseInput,
      context: { ...baseInput.context, workspaceSlug: undefined },
    };

    await fillFormAction(inputNoWs);

    const [, , ctx] = vi.mocked(invoke).mock.calls[0]!;
    expect(ctx.workspaceId).toBe("");
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  // (b) invoke throws — returns noopResult
  it("returns noopResult when invoke throws", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("handler panic"));

    const result = await fillFormAction(baseInput);

    // All fields should be unchanged (proposed === current, changed === false)
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toEqual({ name: "name", current: "old name", proposed: "old name", changed: false });
    expect(result.fields[1]).toEqual({ name: "description", current: "", proposed: "", changed: false });
  });

  it("logs an error when invoke throws", async () => {
    const err = new Error("handler panic");
    vi.mocked(invoke).mockRejectedValue(err);

    await fillFormAction(baseInput);

    expect(logger.error).toHaveBeenCalledWith(
      { err, route: baseInput.context.route },
      "fillFormAction failed",
    );
  });

  // (c) Session failure — returns noopResult
  it("returns noopResult when session resolution fails", async () => {
    vi.mocked(getSessionOrRedirect).mockRejectedValue(new Error("unauthenticated"));

    const result = await fillFormAction(baseInput);

    expect(result.fields[0]).toEqual({ name: "name", current: "old name", proposed: "old name", changed: false });
  });

  it("logs an error when session resolution fails", async () => {
    const err = new Error("unauthenticated");
    vi.mocked(getSessionOrRedirect).mockRejectedValue(err);

    await fillFormAction(baseInput);

    expect(logger.error).toHaveBeenCalledWith(
      { err, route: baseInput.context.route },
      "fillFormAction failed",
    );
  });
});
