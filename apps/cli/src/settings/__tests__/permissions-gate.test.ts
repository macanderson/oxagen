import { describe, it, expect } from "vitest";
import { evaluateLocalPermission, parseRule } from "../permissions-gate.js";
import type { Permissions } from "../schema.js";

describe("parseRule", () => {
  it("parses a bare tool", () => {
    expect(parseRule("Edit")).toEqual({ tool: "Edit" });
  });
  it("parses a tool with a pattern", () => {
    expect(parseRule("Bash(git push*)")).toEqual({ tool: "Bash", pattern: "git push*" });
  });
  it("keeps parens inside the pattern when the rule ends with ')'", () => {
    expect(parseRule("Bash(echo (hi))")).toEqual({ tool: "Bash", pattern: "echo (hi)" });
  });
});

describe("evaluateLocalPermission", () => {
  it("allows everything when no permissions are configured", () => {
    expect(evaluateLocalPermission("bash", { command: "rm -rf /" }, undefined).decision).toBe("allow");
  });

  it("denies a matching deny rule (bash command subject)", () => {
    const perms: Permissions = { deny: ["Bash(rm -rf*)"] };
    const r = evaluateLocalPermission("bash", { command: "rm -rf /tmp/x" }, perms);
    expect(r.decision).toBe("deny");
    expect(r.rule).toBe("Bash(rm -rf*)");
  });

  it("maps write_file to Write and matches on the path subject", () => {
    const perms: Permissions = { deny: ["Write(.env*)"] };
    expect(evaluateLocalPermission("write_file", { path: ".env.local" }, perms).decision).toBe("deny");
    expect(evaluateLocalPermission("write_file", { path: "src/app.ts" }, perms).decision).toBe("allow");
  });

  it("deny wins over allow at the same scope", () => {
    const perms: Permissions = { allow: ["Bash(git*)"], deny: ["Bash(git push*)"] };
    expect(evaluateLocalPermission("bash", { command: "git push origin" }, perms).decision).toBe("deny");
    expect(evaluateLocalPermission("bash", { command: "git status" }, perms).decision).toBe("allow");
  });

  it("allow rule overrides defaultMode deny", () => {
    const perms: Permissions = { defaultMode: "deny", allow: ["Read"] };
    expect(evaluateLocalPermission("read_file", { path: "x.ts" }, perms).decision).toBe("allow");
    expect(evaluateLocalPermission("bash", { command: "ls" }, perms).decision).toBe("deny");
  });

  it("bypassPermissions allows anything not explicitly denied", () => {
    const perms: Permissions = { defaultMode: "bypassPermissions" };
    expect(evaluateLocalPermission("bash", { command: "anything" }, perms).decision).toBe("allow");
    const denied: Permissions = { defaultMode: "bypassPermissions", deny: ["Bash"] };
    expect(evaluateLocalPermission("bash", { command: "x" }, denied).decision).toBe("deny");
  });

  it("a bare tool rule matches every subject for that tool", () => {
    const perms: Permissions = { deny: ["Bash"] };
    expect(evaluateLocalPermission("bash", { command: "echo hi" }, perms).decision).toBe("deny");
  });

  it("default mode allows when nothing matches", () => {
    const perms: Permissions = { deny: ["Write(.env*)"] };
    expect(evaluateLocalPermission("read_file", { path: "x.ts" }, perms).decision).toBe("allow");
  });

  it("handles unknown tools and malformed input safely", () => {
    expect(evaluateLocalPermission("mystery", null, { deny: ["mystery"] }).decision).toBe("deny");
    expect(evaluateLocalPermission("bash", undefined, { deny: ["Bash(x*)"] }).decision).toBe("allow");
  });
});
