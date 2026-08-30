/**
 * page-context-schema.test.ts
 *
 * Unit tests for the pageContext Zod validation rules added to the chat stream
 * route's BodySchema. The schema lives inline in route.ts (which is excluded
 * from coverage per vitest config), so we replicate the relevant sub-schema
 * here to test its bounds in isolation.
 *
 * Covers:
 *   (a) Valid pageContext passes validation
 *   (b) Valid pageContext without fillableForm passes
 *   (c) Null / absent pageContext is accepted (defaults to null)
 *   (d) Oversized fields array (>60) is rejected
 *   (e) Empty fields array is accepted
 *   (f) Field name capped at 256 chars
 *   (g) formId/title capped at 256 chars
 *   (h) entitySummary capped at 500 chars
 *   (i) route capped at 2048 chars
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// ── Replicate the schema from route.ts so we can test it without importing
//    the full route handler (which has many server-only side-effects). ────────

const fieldTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "select",
  "boolean",
]);

const fieldDescriptorSchema = z.object({
  name: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  type: fieldTypeSchema,
  current: z.unknown(),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional(),
  required: z.boolean().optional(),
});

const pageContextSchema = z
  .object({
    route: z.string().min(1).max(2048),
    entitySummary: z.string().max(500).optional(),
    fillableForm: z
      .object({
        formId: z.string().min(1).max(256),
        title: z.string().min(1).max(256),
        fields: z
          .array(
            fieldDescriptorSchema.extend({
              name: z.string().min(1).max(256),
              label: z.string().min(1).max(256),
            }),
          )
          .max(60),
      })
      .optional(),
  })
  .nullable()
  .default(null);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validField = {
  name: "project_name",
  label: "Project Name",
  type: "text" as const,
  current: "old name",
};

const validForm = {
  formId: "create-project",
  title: "Create Project",
  fields: [validField],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pageContext schema", () => {
  // (a)
  it("accepts valid pageContext with fillableForm", () => {
    const result = pageContextSchema.safeParse({
      route: "/acme/prod/projects/new",
      entitySummary: "New project form",
      fillableForm: validForm,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.fillableForm?.formId).toBe("create-project");
    }
  });

  // (b)
  it("accepts valid pageContext without fillableForm", () => {
    const result = pageContextSchema.safeParse({
      route: "/acme/prod/settings",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.fillableForm).toBeUndefined();
    }
  });

  // (c)
  it("accepts null and defaults absent to null", () => {
    const resultNull = pageContextSchema.safeParse(null);
    expect(resultNull.success).toBe(true);
    expect(resultNull.data).toBeNull();

    const resultAbsent = pageContextSchema.safeParse(undefined);
    expect(resultAbsent.success).toBe(true);
    expect(resultAbsent.data).toBeNull();
  });

  // (d)
  it("rejects fillableForm.fields arrays with more than 60 entries", () => {
    const tooManyFields = Array.from({ length: 61 }, (_, i) => ({
      name: `field_${i}`,
      label: `Field ${i}`,
      type: "text" as const,
      current: null,
    }));
    const result = pageContextSchema.safeParse({
      route: "/route",
      fillableForm: { formId: "f", title: "T", fields: tooManyFields },
    });
    expect(result.success).toBe(false);
  });

  // (d boundary) — exactly 60 is OK
  it("accepts fillableForm.fields with exactly 60 entries", () => {
    const maxFields = Array.from({ length: 60 }, (_, i) => ({
      name: `field_${i}`,
      label: `Field ${i}`,
      type: "text" as const,
      current: null,
    }));
    const result = pageContextSchema.safeParse({
      route: "/route",
      fillableForm: { formId: "f", title: "T", fields: maxFields },
    });
    expect(result.success).toBe(true);
  });

  // (e)
  it("accepts an empty fields array", () => {
    const result = pageContextSchema.safeParse({
      route: "/route",
      fillableForm: { formId: "f", title: "T", fields: [] },
    });
    expect(result.success).toBe(true);
  });

  // (f)
  it("rejects a field name longer than 256 chars", () => {
    const result = pageContextSchema.safeParse({
      route: "/route",
      fillableForm: {
        formId: "f",
        title: "T",
        fields: [
          { name: "x".repeat(257), label: "L", type: "text", current: null },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  // (g)
  it("rejects formId longer than 256 chars", () => {
    const result = pageContextSchema.safeParse({
      route: "/route",
      fillableForm: {
        formId: "f".repeat(257),
        title: "T",
        fields: [validField],
      },
    });
    expect(result.success).toBe(false);
  });

  // (h)
  it("rejects entitySummary longer than 500 chars", () => {
    const result = pageContextSchema.safeParse({
      route: "/route",
      entitySummary: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  // (i)
  it("rejects route longer than 2048 chars", () => {
    const result = pageContextSchema.safeParse({
      route: "/".repeat(2049),
    });
    expect(result.success).toBe(false);
  });

  it("accepts entitySummary exactly at 500 chars", () => {
    const result = pageContextSchema.safeParse({
      route: "/route",
      entitySummary: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it("preserves select field options", () => {
    const result = pageContextSchema.safeParse({
      route: "/route",
      fillableForm: {
        formId: "f",
        title: "T",
        fields: [
          {
            name: "status",
            label: "Status",
            type: "select",
            current: "active",
            options: [
              { label: "Active", value: "active" },
              { label: "Archived", value: "archived" },
            ],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.fillableForm?.fields[0]?.options).toHaveLength(2);
    }
  });
});
