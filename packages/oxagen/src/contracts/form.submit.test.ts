import { describe, expect, it } from "vitest";
import { formSubmit } from "./form.submit";
import { getCapability } from "../registry";

describe("form.submit capability", () => {
  // ── input: required form_id ───────────────────────────────────────────────

  it("accepts a minimal valid input with form_id only", () => {
    const parsed = formSubmit.input.parse({ form_id: "frm_abc123" });
    expect(parsed.form_id).toBe("frm_abc123");
    expect(parsed.responses).toBeUndefined();
  });

  it("accepts input with form_id and an empty responses record", () => {
    const parsed = formSubmit.input.parse({
      form_id: "frm_abc123",
      responses: {},
    });
    expect(parsed.form_id).toBe("frm_abc123");
    expect(parsed.responses).toEqual({});
  });

  it("accepts input with form_id and a populated responses record", () => {
    const parsed = formSubmit.input.parse({
      form_id: "frm_abc123",
      responses: {
        email: "alice@example.com",
        rating: 5,
        agree: true,
      },
    });
    expect(parsed.responses?.["email"]).toBe("alice@example.com");
    expect(parsed.responses?.["rating"]).toBe(5);
    expect(parsed.responses?.["agree"]).toBe(true);
  });

  it("rejects missing form_id", () => {
    expect(() => formSubmit.input.parse({})).toThrow();
  });

  it("rejects wrong type for form_id", () => {
    expect(() => formSubmit.input.parse({ form_id: 42 })).toThrow();
  });

  it("rejects null form_id", () => {
    expect(() => formSubmit.input.parse({ form_id: null })).toThrow();
  });

  it("rejects wrong type for responses (array instead of record)", () => {
    expect(() =>
      formSubmit.input.parse({ form_id: "frm_abc123", responses: ["a", "b"] }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with all required fields", () => {
    const parsed = formSubmit.output.parse({
      submission_id: "sub_xyz789",
      status: "submitted",
      created_at: "2024-07-04T10:30:00.000Z",
    });
    expect(parsed.submission_id).toBe("sub_xyz789");
    expect(parsed.status).toBe("submitted");
    expect(parsed.created_at).toBe("2024-07-04T10:30:00.000Z");
  });

  it("parses output with any string status value (no enum constraint)", () => {
    const parsed = formSubmit.output.parse({
      submission_id: "sub_001",
      status: "pending_review",
      created_at: "2024-07-04T10:30:00.000Z",
    });
    expect(parsed.status).toBe("pending_review");
  });

  it("rejects output missing submission_id", () => {
    expect(() =>
      formSubmit.output.parse({
        status: "submitted",
        created_at: "2024-07-04T10:30:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing status", () => {
    expect(() =>
      formSubmit.output.parse({
        submission_id: "sub_xyz789",
        created_at: "2024-07-04T10:30:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with wrong type for submission_id", () => {
    expect(() =>
      formSubmit.output.parse({
        submission_id: 99,
        status: "submitted",
        created_at: "2024-07-04T10:30:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with wrong type for status", () => {
    expect(() =>
      formSubmit.output.parse({
        submission_id: "sub_xyz789",
        status: false,
        created_at: "2024-07-04T10:30:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("form.submit")).toBe(formSubmit);
  });
});
