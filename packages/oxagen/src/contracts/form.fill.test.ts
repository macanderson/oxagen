import { describe, expect, it } from "vitest";
import { formFill } from "./form.fill";

describe("form.fill capability", () => {
  it("parses a valid input with a single text field", () => {
    const parsed = formFill.input.parse({
      route: "/org/ws/settings/general",
      instruction: "Set the name to Acme Corp",
      fields: [
        { name: "name", label: "Name", type: "text", current: "Old name" },
      ],
    });
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.fields[0]?.name).toBe("name");
  });

  it("parses a valid input with multiple field types", () => {
    const parsed = formFill.input.parse({
      route: "/org/ws/settings/general",
      entitySummary: "Workspace: Acme, status: active",
      instruction: "Set the name to Acme Corp and mark it active",
      fields: [
        {
          name: "name",
          label: "Name",
          type: "text",
          current: "Old name",
          required: true,
        },
        {
          name: "status",
          label: "Status",
          type: "select",
          current: "draft",
          options: [
            { label: "Draft", value: "draft" },
            { label: "Active", value: "active" },
          ],
        },
        { name: "count", label: "Count", type: "number", current: 0 },
        { name: "enabled", label: "Enabled", type: "boolean", current: false },
      ],
    });
    expect(parsed.fields).toHaveLength(4);
    expect(parsed.entitySummary).toBe("Workspace: Acme, status: active");
  });

  it("rejects an empty instruction", () => {
    expect(() =>
      formFill.input.parse({
        route: "/org/ws/settings",
        instruction: "",
        fields: [{ name: "name", label: "Name", type: "text", current: "x" }],
      }),
    ).toThrow();
  });

  it("rejects an empty fields array", () => {
    expect(() =>
      formFill.input.parse({
        route: "/org/ws/settings",
        instruction: "Update the name",
        fields: [],
      }),
    ).toThrow();
  });

  it("rejects an invalid field type", () => {
    expect(() =>
      formFill.input.parse({
        route: "/org/ws/settings",
        instruction: "Update the name",
        fields: [
          { name: "name", label: "Name", type: "invalid_type", current: "x" },
        ],
      }),
    ).toThrow();
  });

  it("parses a valid output with changed and unchanged fields", () => {
    const parsed = formFill.output.parse({
      fields: [
        {
          name: "name",
          current: "Old",
          proposed: "New",
          changed: true,
          reason: "User asked to rename",
        },
        { name: "status", current: "draft", proposed: "draft", changed: false },
      ],
    });
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[0]?.changed).toBe(true);
    expect(parsed.fields[1]?.changed).toBe(false);
  });

  it("parses output without optional reason field", () => {
    const parsed = formFill.output.parse({
      fields: [
        { name: "title", current: "Old", proposed: "Old", changed: false },
      ],
    });
    expect(parsed.fields[0]?.reason).toBeUndefined();
  });
});
