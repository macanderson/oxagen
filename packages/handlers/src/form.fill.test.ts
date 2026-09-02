import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

// ── import under test ─────────────────────────────────────────────────────────

import { formFillHandler } from "./form.fill";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── fixtures ──────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const BASE_FIELDS = [
  {
    name: "title",
    label: "Title",
    type: "text" as const,
    current: "Old title",
    required: true,
  },
  {
    name: "status",
    label: "Status",
    type: "select" as const,
    current: "draft",
    options: [
      { label: "Draft", value: "draft" },
      { label: "Active", value: "active" },
    ],
  },
  {
    name: "count",
    label: "Count",
    type: "number" as const,
    current: 0,
  },
];

const BASE_INPUT = {
  route: "/org/ws/projects/123",
  instruction: "Set the title to 'New title' and activate it",
  fields: BASE_FIELDS,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("formFillHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── only instructed fields change ─────────────────────────────────────────

  it("only changes fields the instruction implies, echoes the rest", async () => {
    // Model fills title + status but leaves count unchanged.
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: {
        title: "New title",
        title__reason: "User asked to set title",
        status: "active",
        status__reason: "User asked to activate",
        count: 0,
        count__reason: null,
      },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const result = await formFillHandler(BASE_INPUT, CTX);

    const titleDiff = result.fields.find((f) => f.name === "title");
    const statusDiff = result.fields.find((f) => f.name === "status");
    const countDiff = result.fields.find((f) => f.name === "count");

    expect(titleDiff?.changed).toBe(true);
    expect(titleDiff?.proposed).toBe("New title");
    expect(titleDiff?.reason).toBe("User asked to set title");

    expect(statusDiff?.changed).toBe(true);
    expect(statusDiff?.proposed).toBe("active");
    expect(statusDiff?.reason).toBe("User asked to activate");

    // count not mentioned in instruction → model echoes current value
    expect(countDiff?.changed).toBe(false);
    expect(countDiff?.proposed).toBe(0);
    expect(countDiff?.reason).toBeUndefined();
  });

  // ── diff.changed accuracy ────────────────────────────────────────────────

  it("sets changed=true only when proposed !== current (strict equality)", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: {
        title: "Old title", // same as current — no change
        title__reason: null,
        status: "draft", // same as current — no change
        status__reason: null,
        count: 42, // different — changed
        count__reason: "Updated count",
      },
      usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
    });

    const result = await formFillHandler(BASE_INPUT, CTX);

    const titleDiff = result.fields.find((f) => f.name === "title");
    const statusDiff = result.fields.find((f) => f.name === "status");
    const countDiff = result.fields.find((f) => f.name === "count");

    expect(titleDiff?.changed).toBe(false);
    expect(statusDiff?.changed).toBe(false);
    expect(countDiff?.changed).toBe(true);
    expect(countDiff?.proposed).toBe(42);
  });

  it("sets changed=false when string field proposed equals current exactly", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: {
        title: "Old title",
        title__reason: null,
        status: "draft",
        status__reason: null,
        count: 0,
        count__reason: null,
      },
      usage: { promptTokens: 6, completionTokens: 2, totalTokens: 8 },
    });

    const result = await formFillHandler(BASE_INPUT, CTX);

    expect(result.fields.every((f) => !f.changed)).toBe(true);
  });

  // ── model error → all unchanged, no throw ────────────────────────────────

  it("returns all fields unchanged and does not throw when the model errors", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(
      new Error("Model unavailable"),
    );

    const result = await formFillHandler(BASE_INPUT, CTX);

    // All three fields must be present and unchanged.
    expect(result.fields).toHaveLength(3);
    for (const diff of result.fields) {
      expect(diff.changed).toBe(false);
      expect(diff.proposed).toStrictEqual(diff.current);
      // Reason must be present (error explanation).
      expect(typeof diff.reason).toBe("string");
    }

    // Handler must not throw — vitest would catch it above, but asserting the
    // result shape demonstrates the intent clearly.
  });

  // ── telemetry forwarded ───────────────────────────────────────────────────

  it("forwards telemetry context to generateObjectFor", async () => {
    let capturedTelemetry: Record<string, unknown> | null = null;
    mocks.generateObjectFor.mockImplementationOnce(
      (args: { telemetry: Record<string, unknown> }) => {
        capturedTelemetry = args.telemetry;
        return Promise.resolve({
          object: {
            title: "New title",
            title__reason: null,
            status: "draft",
            status__reason: null,
            count: 0,
            count__reason: null,
          },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      },
    );

    const ctxWithMessage: CapabilityContext = {
      ...CTX,
      messageId: "msg_abc",
    };

    await formFillHandler(BASE_INPUT, ctxWithMessage);

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    expect(capturedTelemetry).not.toBeNull();
    expect(capturedTelemetry?.["orgId"]).toBe("org_1");
    expect(capturedTelemetry?.["workspaceId"]).toBe("ws_1");
    expect(capturedTelemetry?.["messageId"]).toBe("msg_abc");
  });

  it("falls back to requestId when messageId is null", async () => {
    let capturedTelemetry: Record<string, unknown> | null = null;
    mocks.generateObjectFor.mockImplementationOnce(
      (args: { telemetry: Record<string, unknown> }) => {
        capturedTelemetry = args.telemetry;
        return Promise.resolve({
          object: {
            title: "x",
            title__reason: null,
            status: "draft",
            status__reason: null,
            count: 0,
            count__reason: null,
          },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        });
      },
    );

    await formFillHandler(BASE_INPUT, { ...CTX, messageId: null });

    expect(capturedTelemetry?.["messageId"]).toBe("req_1");
  });

  // ── result shape completeness ─────────────────────────────────────────────

  it("returns a diff entry for every input field, in order", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: {
        title: "T",
        title__reason: null,
        status: "draft",
        status__reason: null,
        count: 0,
        count__reason: null,
      },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await formFillHandler(BASE_INPUT, CTX);

    expect(result.fields).toHaveLength(BASE_FIELDS.length);
    result.fields.forEach((diff, i) => {
      expect(diff.name).toBe(BASE_FIELDS[i]?.name);
    });
  });
});
