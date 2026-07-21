import { describe, it, expect } from "vitest";
import { renderEntityText } from "./index";

describe("renderEntityText", () => {
  it("produces entityType + displayName + key:value fields", () => {
    const text = renderEntityText("task", "Fix bug", {
      state: "open",
      priority: 1,
    });
    expect(text).toContain("task");
    expect(text).toContain("Fix bug");
    expect(text).toContain("state:open");
    expect(text).toContain("priority:1");
  });

  it("includes boolean properties", () => {
    const text = renderEntityText("task", "Review PR", { merged: true });
    expect(text).toContain("merged:true");
  });

  it("omits null and undefined properties", () => {
    const text = renderEntityText("doc", "My doc", {
      title: "My doc",
      empty: null,
      missing: undefined,
    });
    expect(text).not.toContain("empty");
    expect(text).not.toContain("missing");
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
  });

  it("omits array properties (non-primitive)", () => {
    const text = renderEntityText("contact", "Alice", {
      emails: ["alice@a.com", "alice@b.com"],
      email: "alice@a.com",
    });
    expect(text).not.toContain("alice@a.com,alice@b.com");
    expect(text).toContain("email:alice@a.com");
  });

  it("omits nested object properties", () => {
    const text = renderEntityText("meeting", "Team sync", {
      organizer: { name: "Bob", email: "bob@x.com" },
      duration: 30,
    });
    expect(text).toContain("duration:30");
    // The nested object should be omitted (not primitive)
    expect(text).not.toContain("organizer:{");
  });

  it("works without a displayName", () => {
    const text = renderEntityText("entity", undefined, { id: "e-1" });
    expect(text).toContain("entity");
    expect(text).toContain("id:e-1");
  });

  it("works with empty properties", () => {
    const text = renderEntityText("node", "My node", {});
    expect(text).toContain("node");
    expect(text).toContain("My node");
  });

  it("produces a non-empty string for minimal input", () => {
    const text = renderEntityText("task", undefined, {});
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
