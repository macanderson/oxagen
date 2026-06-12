import { describe, expect, it } from "vitest";
import { formCreate } from "./form.create";
import { getCapability } from "../registry";

describe("form.create capability", () => {
  // ── input: required title ─────────────────────────────────────────────────

  it("accepts a minimal valid input with title only", () => {
    const parsed = formCreate.input.parse({ title: "Feedback Form" });
    expect(parsed.title).toBe("Feedback Form");
    expect(parsed.fields).toBeUndefined();
  });

  it("accepts input with title and an empty fields array", () => {
    const parsed = formCreate.input.parse({ title: "Survey", fields: [] });
    expect(parsed.title).toBe("Survey");
    expect(parsed.fields).toEqual([]);
  });

  it("accepts input with title and a populated fields array", () => {
    const parsed = formCreate.input.parse({
      title: "Survey",
      fields: [
        { name: "email", type: "text", required: true },
        { name: "rating", type: "number" },
      ],
    });
    expect(parsed.fields).toHaveLength(2);
  });

  it("accepts title of exactly 1 character (min boundary)", () => {
    const parsed = formCreate.input.parse({ title: "A" });
    expect(parsed.title).toBe("A");
  });

  it("rejects an empty title (min 1)", () => {
    expect(() => formCreate.input.parse({ title: "" })).toThrow();
  });

  it("rejects missing title", () => {
    expect(() => formCreate.input.parse({})).toThrow();
  });

  it("rejects wrong type for title", () => {
    expect(() => formCreate.input.parse({ title: 123 })).toThrow();
  });

  it("rejects wrong type for fields (object instead of array)", () => {
    expect(() =>
      formCreate.input.parse({ title: "Form", fields: { name: "email" } }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with all required fields", () => {
    const parsed = formCreate.output.parse({
      form_id: "frm_abc123",
      title: "Feedback Form",
      created_at: "2024-06-01T08:00:00.000Z",
    });
    expect(parsed.form_id).toBe("frm_abc123");
    expect(parsed.title).toBe("Feedback Form");
    expect(parsed.created_at).toBe("2024-06-01T08:00:00.000Z");
  });

  it("rejects output missing form_id", () => {
    expect(() =>
      formCreate.output.parse({
        title: "Feedback Form",
        created_at: "2024-06-01T08:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing title", () => {
    expect(() =>
      formCreate.output.parse({
        form_id: "frm_abc123",
        created_at: "2024-06-01T08:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with wrong type for form_id", () => {
    expect(() =>
      formCreate.output.parse({
        form_id: 42,
        title: "Feedback Form",
        created_at: "2024-06-01T08:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("form.create")).toBe(formCreate);
  });
});
