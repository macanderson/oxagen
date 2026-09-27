import { describe, it, expect } from "vitest";
import { renderEntityText, storedEntityText } from "./index";

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

describe("storedEntityText", () => {
  const properties = { state: "open", number: 42, merged: false };

  it("renders the same text the pipeline embedded for the record", () => {
    const text = storedEntityText({
      entityType: "Issue",
      displayName: "Fix login",
      naturalKey: "github:con-1:issue-42",
      properties: JSON.stringify(properties),
    });
    expect(text).toBe(renderEntityText("Issue", "Fix login", properties));
  });

  it("drops a display name that is the natural key, which the node stores when the record had none", () => {
    const text = storedEntityText({
      entityType: "Issue",
      displayName: "github:con-1:issue-42",
      naturalKey: "github:con-1:issue-42",
      properties: JSON.stringify(properties),
    });
    expect(text).toBe(renderEntityText("Issue", undefined, properties));
    expect(text).not.toContain("github:con-1:issue-42");
  });

  it("reads absent, malformed, and non-object properties as none", () => {
    for (const raw of [null, "", "{not json", "[1,2]", "7"]) {
      expect(
        storedEntityText({
          entityType: "Issue",
          displayName: "Fix login",
          naturalKey: "k",
          properties: raw,
        }),
      ).toBe(renderEntityText("Issue", "Fix login", {}));
    }
  });
});
