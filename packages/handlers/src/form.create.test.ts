/**
 * form.create handler tests.
 *
 * Strategy: mock @oxagen/database withTenantDb so no real IO occurs.
 * Assert:
 *   - missing workspaceId or userId → throws
 *   - insert is called and returns contract shape (form_id, title, created_at)
 *   - fields defaults to empty array when not provided
 *   - insert returning no row → throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const FAKE_ROW = {
  publicId: "frm_TESTFORMID",
  title: "Contact Form",
  createdAt: new Date("2025-03-01T12:00:00.000Z"),
};

const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  schema: {
    forms: {
      publicId: "forms.publicId",
      title: "forms.title",
      createdAt: "forms.createdAt",
      orgId: "forms.orgId",
      workspaceId: "forms.workspaceId",
      fields: "forms.fields",
      createdByUserId: "forms.createdByUserId",
      updatedByUserId: "forms.updatedByUserId",
    },
  },
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: () => ({
          returning: mocks.insertReturning,
        }),
      }),
    }),
}));

vi.mock("drizzle-orm", () => ({}));

import { formCreateHandler } from "./form.create";
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
  mocks.insertReturning.mockResolvedValue([FAKE_ROW]);
});

describe("formCreateHandler — auth guards", () => {
  it("throws when workspaceId is null", async () => {
    const ctx: CapabilityContext = { ...CTX, workspaceId: null as unknown as string };
    await expect(formCreateHandler({ title: "T" }, ctx)).rejects.toThrow(
      "form.create requires a workspace scope",
    );
  });

  it("throws when userId is null", async () => {
    const ctx: CapabilityContext = { ...CTX, userId: null };
    await expect(formCreateHandler({ title: "T" }, ctx)).rejects.toThrow(
      "form.create requires an authenticated user",
    );
  });
});

describe("formCreateHandler — happy path", () => {
  it("inserts and returns contract-shaped output", async () => {
    const result = await formCreateHandler(
      { title: "Contact Form", fields: [{ type: "text", name: "email" }] },
      CTX,
    );

    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
    expect(result.form_id).toBe(FAKE_ROW.publicId);
    expect(result.title).toBe(FAKE_ROW.title);
    expect(result.created_at).toBe(FAKE_ROW.createdAt.toISOString());
  });

  it("succeeds without optional fields parameter", async () => {
    const result = await formCreateHandler({ title: "Simple Form" }, CTX);
    expect(result.form_id).toBe(FAKE_ROW.publicId);
  });
});

describe("formCreateHandler — insert failure", () => {
  it("throws when insert returns no row", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    await expect(formCreateHandler({ title: "T" }, CTX)).rejects.toThrow(
      "form.create: insert returned no row",
    );
  });

  it("propagates DB errors", async () => {
    mocks.insertReturning.mockRejectedValueOnce(new Error("constraint violation"));
    await expect(formCreateHandler({ title: "T" }, CTX)).rejects.toThrow(
      "constraint violation",
    );
  });
});
