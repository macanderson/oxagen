/**
 * fill-action.test.ts — unit tests for fillFormAction server action.
 *
 * Covers:
 *   (a) Happy path — handler returns diffs, action maps them to FormFillResult
 *   (b) Handler throws — action returns noopResult (regression for the silent-catch fix)
 *   (c) Session failure — action returns noopResult
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

vi.mock("@oxagen/handlers/form.fill", () => ({
  formFillHandler: vi.fn(),
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { fillFormAction, type FillFormActionInput } from "./fill-action.js";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { formFillHandler } from "@oxagen/handlers/form.fill";
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
    vi.mocked(resolveOrg).mockResolvedValue(mockOrg);
    vi.mocked(resolveWorkspace).mockResolvedValue(mockWorkspace);
  });

  // (a) Happy path
  it("maps handler diffs to FormFillResult on success", async () => {
    vi.mocked(formFillHandler).mockResolvedValue({
      fields: [
        { name: "name", current: "old name", proposed: "My Project", changed: true, reason: "Instruction says so" },
        { name: "description", current: "", proposed: "", changed: false },
      ],
    } as never);

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

  it("passes the correct ctx to formFillHandler", async () => {
    vi.mocked(formFillHandler).mockResolvedValue({ fields: [] } as never);

    await fillFormAction(baseInput);

    const [handlerInput, ctx] = vi.mocked(formFillHandler).mock.calls[0]!;
    expect(ctx.orgId).toBe("org-abc");
    expect(ctx.workspaceId).toBe("ws-xyz");
    expect(ctx.userId).toBe("user-123");
    expect(ctx.surface).toBe("app");
    expect(handlerInput.route).toBe("/acme/prod/knowledge");
    expect(handlerInput.instruction).toBe(baseInput.instruction);
  });

  it("omits workspaceId when workspaceSlug is absent", async () => {
    vi.mocked(formFillHandler).mockResolvedValue({ fields: [] } as never);

    const inputNoWs: FillFormActionInput = {
      ...baseInput,
      context: { ...baseInput.context, workspaceSlug: undefined },
    };

    await fillFormAction(inputNoWs);

    const [, ctx] = vi.mocked(formFillHandler).mock.calls[0]!;
    expect(ctx.workspaceId).toBe("");
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  // (b) Handler throws — returns noopResult
  it("returns noopResult when formFillHandler throws", async () => {
    vi.mocked(formFillHandler).mockRejectedValue(new Error("handler panic"));

    const result = await fillFormAction(baseInput);

    // All fields should be unchanged (proposed === current, changed === false)
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toEqual({ name: "name", current: "old name", proposed: "old name", changed: false });
    expect(result.fields[1]).toEqual({ name: "description", current: "", proposed: "", changed: false });
  });

  it("logs an error when the handler throws", async () => {
    const err = new Error("handler panic");
    vi.mocked(formFillHandler).mockRejectedValue(err);

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
