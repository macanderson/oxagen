import { describe, it, expect } from "vitest";
import {
  matchGlob,
  evaluatePermission,
  filterToolVisibility,
  getNonDeniedTools,
} from "./permissions.ts";
import type { Permissions } from "./schema.ts";

describe("matchGlob", () => {
  it("matches exact names", () => {
    expect(matchGlob("delete_repo", "delete_repo")).toBe(true);
    expect(matchGlob("delete_repo", "delete_branch")).toBe(false);
  });

  it("matches universal wildcard", () => {
    expect(matchGlob("*", "anything")).toBe(true);
    expect(matchGlob("*", "")).toBe(true);
  });

  it("matches prefix wildcards", () => {
    expect(matchGlob("delete_*", "delete_repo")).toBe(true);
    expect(matchGlob("delete_*", "delete_")).toBe(true);
    expect(matchGlob("delete_*", "create_repo")).toBe(false);
  });

  it("matches suffix wildcards", () => {
    expect(matchGlob("*_force", "push_force")).toBe(true);
    expect(matchGlob("*_force", "force")).toBe(false);
  });

  it("matches middle wildcards", () => {
    expect(matchGlob("admin_*_force", "admin_delete_force")).toBe(true);
    expect(matchGlob("admin_*_force", "admin_force")).toBe(false);
  });
});

describe("evaluatePermission", () => {
  const permissions: Permissions = {
    defaultMcpPolicy: "ask",
    mcpServers: {
      github: {
        defaultPolicy: "allow",
        deny: ["delete_*"],
        allow: ["get_*"],
      },
      locked: {
        defaultPolicy: "deny",
      },
    },
  };

  it("denies when tool matches a deny pattern", () => {
    const result = evaluatePermission("github", "delete_repo", permissions);
    expect(result.decision).toBe("deny");
  });

  it("allows when tool matches an allow pattern and no deny", () => {
    const result = evaluatePermission("github", "get_issues", permissions);
    expect(result.decision).toBe("allow");
  });

  it("falls back to server defaultPolicy when no rule matches", () => {
    const result = evaluatePermission("github", "create_pr", permissions);
    expect(result.decision).toBe("allow");
  });

  it("falls back to global defaultMcpPolicy for unknown servers", () => {
    const result = evaluatePermission("unknown", "any_tool", permissions);
    expect(result.decision).toBe("ask");
  });

  it("uses server deny-all defaultPolicy", () => {
    const result = evaluatePermission("locked", "any_tool", permissions);
    expect(result.decision).toBe("deny");
  });

  it("returns ask when no permissions configured", () => {
    const result = evaluatePermission("any", "any", undefined);
    expect(result.decision).toBe("ask");
  });
});

describe("filterToolVisibility", () => {
  const tools = ["get_user", "delete_user", "list_repos", "admin_panel"];

  it("returns all tools when no visibility config", () => {
    expect(filterToolVisibility(tools, undefined)).toEqual(tools);
  });

  it("filters to include only matching tools", () => {
    const result = filterToolVisibility(tools, {
      include: ["get_*", "list_*"],
    });
    expect(result).toEqual(["get_user", "list_repos"]);
  });

  it("excludes matching tools", () => {
    const result = filterToolVisibility(tools, { exclude: ["admin_*"] });
    expect(result).toEqual(["get_user", "delete_user", "list_repos"]);
  });

  it("applies exclude after include", () => {
    const result = filterToolVisibility(tools, {
      include: ["get_*", "delete_*"],
      exclude: ["delete_*"],
    });
    expect(result).toEqual(["get_user"]);
  });
});

describe("getNonDeniedTools", () => {
  const permissions: Permissions = {
    defaultMcpPolicy: "allow",
    mcpServers: {
      server: { deny: ["dangerous_*"] },
    },
  };

  it("filters out denied tools", () => {
    const tools = ["safe_read", "dangerous_delete", "safe_write"];
    const result = getNonDeniedTools("server", tools, permissions);
    expect(result).toEqual(["safe_read", "safe_write"]);
  });

  it("keeps all tools when no deny rules", () => {
    const tools = ["a", "b", "c"];
    const result = getNonDeniedTools("other", tools, permissions);
    expect(result).toEqual(["a", "b", "c"]);
  });
});
