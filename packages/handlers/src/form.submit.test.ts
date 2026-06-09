/**
 * form.submit handler tests.
 *
 * Strategy: mock @oxagen/database withTenantDb so no real IO occurs.
 * Two queries happen in sequence:
 *   1. select form by publicId → returns { id } or []
 *   2. insert submission → returns { publicId, status, createdAt }
 *
 * The mock tracks call count to distinguish the two withTenantDb invocations.
 * Assert:
 *   - missing workspaceId or userId → throws
 *   - form not found → throws with form_id in message
 *   - happy path → returns contract shape (submission_id, status, created_at)
 *   - submission insert returning no row → throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const FAKE_FORM = { id: "internal-form-uuid-1234" };
const FAKE_SUB_ROW = {
  publicId: "fsb_SUBMISSIONID",
  status: "submitted",
  createdAt: new Date("2025-04-10T09:15:00.000Z"),
};

const mocks = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  insertReturning: vi.fn(),
  callCount: { value: 0 },
}));

vi.mock("@oxagen/database", () => ({
  schema: {
    forms: {
      publicId: "forms.publicId",
      workspaceId: "forms.workspaceId",
      deletedAt: "forms.deletedAt",
      id: "forms.id",
    },
    formSubmissions: {
      publicId: "formSubmissions.publicId",
      status: "formSubmissions.status",
      createdAt: "formSubmissions.createdAt",
      orgId: "formSubmissions.orgId",
      workspaceId: "formSubmissions.workspaceId",
      formId: "formSubmissions.formId",
      responses: "formSubmissions.responses",
      createdByUserId: "formSubmissions.createdByUserId",
      updatedByUserId: "formSubmissions.updatedByUserId",
    },
  },
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    mocks.callCount.value += 1;
    if (mocks.callCount.value % 2 === 1) {
      // Odd call = first withTenantDb per handler invocation = form lookup select
      return fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: mocks.selectLimit,
            }),
          }),
        }),
      });
    } else {
      // Even call = second withTenantDb = submission insert
      return fn({
        insert: () => ({
          values: () => ({
            returning: mocks.insertReturning,
          }),
        }),
      });
    }
  },
}));

import { formSubmitHandler } from "./form.submit";
import type { CapabilityContext } from "@oxagen/oxagen";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callCount.value = 0;
  mocks.selectLimit.mockResolvedValue([FAKE_FORM]);
  mocks.insertReturning.mockResolvedValue([FAKE_SUB_ROW]);
});

describe("formSubmitHandler — auth guards", () => {
  it("throws when workspaceId is null", async () => {
    const ctx: CapabilityContext = { ...CTX, workspaceId: null as unknown as string };
    await expect(formSubmitHandler({ form_id: "frm_X" }, ctx)).rejects.toThrow(
      "form.submit requires a workspace scope",
    );
  });

  it("throws when userId is null", async () => {
    const ctx: CapabilityContext = { ...CTX, userId: null };
    await expect(formSubmitHandler({ form_id: "frm_X" }, ctx)).rejects.toThrow(
      "form.submit requires an authenticated user",
    );
  });
});

describe("formSubmitHandler — form not found", () => {
  it("throws when form lookup returns no row", async () => {
    mocks.selectLimit.mockResolvedValueOnce([]);
    await expect(formSubmitHandler({ form_id: "frm_MISSING" }, CTX)).rejects.toThrow(
      'form.submit: form "frm_MISSING" not found',
    );
  });
});

describe("formSubmitHandler — happy path", () => {
  it("performs two DB calls and returns contract-shaped output", async () => {
    const result = await formSubmitHandler(
      { form_id: "frm_REAL", responses: { name: "Alice" } },
      CTX,
    );

    // Both DB calls happened
    expect(mocks.selectLimit).toHaveBeenCalledTimes(1);
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);

    // Output matches contract
    expect(result.submission_id).toBe(FAKE_SUB_ROW.publicId);
    expect(result.status).toBe("submitted");
    expect(result.created_at).toBe(FAKE_SUB_ROW.createdAt.toISOString());
  });

  it("succeeds when responses is not provided (defaults to {})", async () => {
    const result = await formSubmitHandler({ form_id: "frm_REAL" }, CTX);
    expect(result.submission_id).toBe(FAKE_SUB_ROW.publicId);
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
  });
});

describe("formSubmitHandler — insert failure", () => {
  it("throws when submission insert returns no row", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    await expect(
      formSubmitHandler({ form_id: "frm_REAL", responses: {} }, CTX),
    ).rejects.toThrow("form.submit: insert returned no row");
  });

  it("propagates DB errors from the submission insert", async () => {
    mocks.insertReturning.mockRejectedValueOnce(new Error("db write failed"));
    await expect(
      formSubmitHandler({ form_id: "frm_REAL", responses: {} }, CTX),
    ).rejects.toThrow("db write failed");
  });
});
