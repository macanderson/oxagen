import { describe, it, expect } from "vitest";
import {
  validateNamespace,
  namespaceKey,
  isWithinNamespace,
  workspaceNamespace,
  sessionNamespace,
  NamespaceScopeError,
} from "./namespace";
import type { Namespace } from "./types";

describe("validateNamespace", () => {
  it("accepts a valid workspace-level namespace", () => {
    const ns = validateNamespace({ org: "org-1", workspace: "ws-1" });
    expect(ns).toEqual({ org: "org-1", workspace: "ws-1" });
  });

  it("accepts a valid session-scoped namespace", () => {
    const ns = validateNamespace({
      org: "org-1",
      workspace: "ws-1",
      session: "sess-1",
      agent: "agent-1",
    });
    expect(ns).toEqual({
      org: "org-1",
      workspace: "ws-1",
      session: "sess-1",
      agent: "agent-1",
    });
  });

  it("throws NamespaceScopeError for missing org", () => {
    expect(() => validateNamespace({ workspace: "ws-1" })).toThrow(
      NamespaceScopeError,
    );
  });

  it("throws NamespaceScopeError for empty org", () => {
    expect(() => validateNamespace({ org: "", workspace: "ws-1" })).toThrow(
      NamespaceScopeError,
    );
  });

  it("throws NamespaceScopeError for missing workspace", () => {
    expect(() => validateNamespace({ org: "org-1" })).toThrow(
      NamespaceScopeError,
    );
  });

  it("throws NamespaceScopeError for null input", () => {
    expect(() => validateNamespace(null)).toThrow(NamespaceScopeError);
  });
});

describe("namespaceKey", () => {
  it("produces org:workspace for workspace-level", () => {
    expect(namespaceKey({ org: "o", workspace: "w" })).toBe("o:w");
  });

  it("includes session when present", () => {
    expect(namespaceKey({ org: "o", workspace: "w", session: "s" })).toBe(
      "o:w:s",
    );
  });

  it("includes agent when session and agent are present", () => {
    expect(
      namespaceKey({ org: "o", workspace: "w", session: "s", agent: "a" }),
    ).toBe("o:w:s:a");
  });

  it("does not include agent without session", () => {
    // agent without session is technically valid in the type but namespaceKey
    // only appends agent when session is present (hierarchical)
    expect(namespaceKey({ org: "o", workspace: "w", agent: "a" })).toBe("o:w");
  });
});

describe("isWithinNamespace", () => {
  const parent: Namespace = { org: "org-1", workspace: "ws-1" };

  it("returns true for identical namespaces", () => {
    expect(isWithinNamespace(parent, parent)).toBe(true);
  });

  it("returns true for child session within parent workspace", () => {
    const child: Namespace = { org: "org-1", workspace: "ws-1", session: "s" };
    expect(isWithinNamespace(child, parent)).toBe(true);
  });

  it("returns false for different org", () => {
    const child: Namespace = { org: "org-2", workspace: "ws-1" };
    expect(isWithinNamespace(child, parent)).toBe(false);
  });

  it("returns false for different workspace", () => {
    const child: Namespace = { org: "org-1", workspace: "ws-2" };
    expect(isWithinNamespace(child, parent)).toBe(false);
  });

  it("returns false when child session doesn't match parent session", () => {
    const parentWithSession: Namespace = {
      org: "org-1",
      workspace: "ws-1",
      session: "s1",
    };
    const child: Namespace = { org: "org-1", workspace: "ws-1", session: "s2" };
    expect(isWithinNamespace(child, parentWithSession)).toBe(false);
  });
});

describe("workspaceNamespace", () => {
  it("creates a workspace-level namespace", () => {
    expect(workspaceNamespace("o", "w")).toEqual({ org: "o", workspace: "w" });
  });
});

describe("sessionNamespace", () => {
  it("creates a session-scoped namespace", () => {
    expect(sessionNamespace("o", "w", "s", "a")).toEqual({
      org: "o",
      workspace: "w",
      session: "s",
      agent: "a",
    });
  });

  it("omits agent when not provided", () => {
    expect(sessionNamespace("o", "w", "s")).toEqual({
      org: "o",
      workspace: "w",
      session: "s",
      agent: undefined,
    });
  });
});
