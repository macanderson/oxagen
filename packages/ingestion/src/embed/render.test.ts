import { describe, it, expect } from "vitest";
import { renderEntityText, renderFileText, renderSymbolText } from "./index";
import type { ParsedSymbol } from "../parsers/types";

describe("renderEntityText", () => {
  it("produces entityType + displayName + key:value fields", () => {
    const text = renderEntityText("task", "Fix bug", { state: "open", priority: 1 });
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

describe("renderFileText", () => {
  it("includes path, language, title, symbol names, and the content head", () => {
    const text = renderFileText({
      path: "src/auth/login.ts",
      language: "typescript",
      content: "export function login() { return retryOn5xx(); }",
      title: "Login module",
      symbolNames: ["login", "logout"],
    });
    expect(text).toContain("src/auth/login.ts");
    expect(text).toContain("typescript");
    expect(text).toContain("Login module");
    expect(text).toContain("login");
    expect(text).toContain("retryOn5xx"); // real content, not just the path/name
  });

  it("caps the content head and tolerates missing title/symbols", () => {
    const big = "x".repeat(5000);
    const text = renderFileText({ path: "a.py", language: "python", content: big });
    expect(text).toContain("a.py");
    // Only the first ~1500 chars of content are embedded.
    expect(text.length).toBeLessThan(2000);
  });
});

describe("renderSymbolText", () => {
  it("includes kind, name, signature, doc comment, and the code slice", () => {
    const symbol: ParsedSymbol = {
      name: "fetchUser",
      kind: "function",
      startLine: 10,
      endLine: 20,
      signature: "function fetchUser(id: string): Promise<User>",
      docComment: "Fetches a user by id, retrying on 5xx.",
      code: "function fetchUser(id) { return get(`/users/${id}`); }",
    };
    const text = renderSymbolText(symbol, "src/users.ts");
    expect(text).toContain("function fetchUser");
    expect(text).toContain("src/users.ts");
    expect(text).toContain("Promise<User>");
    expect(text).toContain("retrying on 5xx");
    expect(text).toContain("get(`/users/${id}`)");
  });

  it("tolerates a symbol with no signature/doc/code", () => {
    const symbol: ParsedSymbol = { name: "X", kind: "class", startLine: 0, endLine: 0 };
    const text = renderSymbolText(symbol, "x.ts");
    expect(text).toContain("class X");
    expect(text).toContain("x.ts");
  });
});
