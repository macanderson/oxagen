import { describe, expect, it } from "vitest";
import {
  evaluatePreToolUse,
  globToRegex,
  parseRule,
  ruleMatches,
  verifyBundle,
} from "./bundle";
import { bundleSigner, unsignedBundle } from "./test-support";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

describe("rule matching", () => {
  it("parses bare tools and tool(spec) rules", () => {
    expect(parseRule("Bash")).toEqual({ raw: "Bash", tool: "Bash" });
    expect(parseRule("Bash(git push*)")).toEqual({
      raw: "Bash(git push*)",
      tool: "Bash",
      spec: "git push*",
    });
    expect(parseRule("Weird(")).toEqual({ raw: "Weird(", tool: "Weird(" });
  });

  it("matches Bash commands by glob and legacy prefix", () => {
    const push = parseRule("Bash(git push*)");
    expect(ruleMatches(push, "Bash", { command: "git push origin main" })).toBe(
      true,
    );
    expect(ruleMatches(push, "Bash", { command: "git pull" })).toBe(false);
    expect(
      ruleMatches(parseRule("Bash(npm run:*)"), "Bash", {
        command: "npm run test",
      }),
    ).toBe(true);
    expect(
      ruleMatches(parseRule("Bash(ls)"), "Bash", { command: "ls -la" }),
    ).toBe(false);
    expect(
      ruleMatches(parseRule("Bash"), "Bash", { command: "anything" }),
    ).toBe(true);
    expect(ruleMatches(parseRule("Bash(x)"), "Bash", undefined)).toBe(false);
  });

  it("matches file tools against relative, absolute, and home paths", () => {
    const rule = parseRule("Write(src/**)");
    expect(
      ruleMatches(
        rule,
        "Write",
        { file_path: "/repo/src/a/b.ts" },
        { cwd: "/repo" },
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        rule,
        "Write",
        { file_path: "/repo/docs/a.md" },
        { cwd: "/repo" },
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        parseRule("Read(~/.zshrc)"),
        "Read",
        { file_path: "/home/dev/.zshrc" },
        { home: "/home/dev" },
      ),
    ).toBe(true);
    expect(
      ruleMatches(parseRule("Write(//etc/**)"), "Write", {
        file_path: "/etc/hosts",
      }),
    ).toBe(true);
    expect(
      ruleMatches(parseRule("Edit(*.md)"), "Edit", { file_path: "README.md" }),
    ).toBe(true);
    expect(
      ruleMatches(parseRule("Edit(*.md)"), "Edit", {
        file_path: "docs/README.md",
      }),
    ).toBe(false);
    expect(
      ruleMatches(parseRule("Grep(src/**)"), "Grep", { path: "src/x" }),
    ).toBe(true);
  });

  it("matches MCP servers, wildcards, and web domains", () => {
    expect(
      ruleMatches(parseRule("mcp__github"), "mcp__github__create_issue", {}),
    ).toBe(true);
    expect(
      ruleMatches(parseRule("mcp__github__*"), "mcp__github__create_issue", {}),
    ).toBe(true);
    expect(
      ruleMatches(
        parseRule("mcp__github__create_issue"),
        "mcp__github__list",
        {},
      ),
    ).toBe(false);
    expect(ruleMatches(parseRule("mcp__slack"), "mcp__github__x", {})).toBe(
      false,
    );
    expect(
      ruleMatches(parseRule("WebFetch(domain:example.com)"), "WebFetch", {
        url: "https://example.com/x",
      }),
    ).toBe(true);
    expect(
      ruleMatches(parseRule("WebFetch(domain:example.com)"), "WebFetch", {
        url: "https://evil.com/x",
      }),
    ).toBe(false);
    expect(
      ruleMatches(parseRule("WebFetch(domain:example.com)"), "WebFetch", {
        url: "not a url",
      }),
    ).toBe(false);
    expect(ruleMatches(parseRule("WebFetch(x)"), "WebFetch", {})).toBe(false);
    expect(
      ruleMatches(parseRule("WebSearch(*claude*)"), "WebSearch", {
        query: "claude hooks",
      }),
    ).toBe(true);
    expect(
      ruleMatches(parseRule('Task(*"subagent_type":"Explore"*)'), "Task", {
        subagent_type: "Explore",
      }),
    ).toBe(true);
  });

  it("compiles globs where ** crosses separators and * does not", () => {
    expect(globToRegex("a/**/b").test("a/x/y/b")).toBe(true);
    expect(globToRegex("a/*/b").test("a/x/y/b")).toBe(false);
    expect(globToRegex("a?c").test("abc")).toBe(true);
    expect(globToRegex("a.c").test("abc")).toBe(false);
  });
});

describe("bundle verification", () => {
  it("accepts a bundle signed by the enrollment key and refuses others", () => {
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    expect(verifyBundle(bundle, signer.publicKeyPem).ok).toBe(true);
    const other = bundleSigner();
    expect(verifyBundle(bundle, other.publicKeyPem)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("key id"),
    });
    const tampered = { ...bundle, mode: "observe" as const };
    expect(verifyBundle(tampered, signer.publicKeyPem)).toMatchObject({
      ok: false,
      reason: "signature does not verify",
    });
    expect(
      verifyBundle(
        { ...bundle, signature: { ...bundle.signature, alg: "rsa" as never } },
        signer.publicKeyPem,
      ).ok,
    ).toBe(false);
    expect(
      verifyBundle(
        { ...bundle, signature: { ...bundle.signature, sig: "!!" } },
        signer.publicKeyPem,
      ).ok,
    ).toBe(false);
    expect(verifyBundle(bundle, "not a pem").ok).toBe(false);
  });
});

describe("PreToolUse evaluation", () => {
  const signer = bundleSigner();
  const bundle = signer.sign(unsignedBundle());
  const base = {
    bundle,
    bundleVerified: true,
    hostStatus: "active" as const,
    latestDenyGeneration: { org: 1, workspace: 1 },
    controlReachable: true,
    now: NOW,
    context: { cwd: "/repo" },
  };

  it("denies for host and session state before any rule", () => {
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Read",
        hostStatus: "suspended",
      }),
    ).toMatchObject({
      decision: "deny",
      source: "human",
      reason_code: "host_suspended",
    });
    expect(
      evaluatePreToolUse({ ...base, toolName: "Read", hostStatus: "paused" })
        .reason_code,
    ).toBe("host_paused");
    expect(
      evaluatePreToolUse({ ...base, toolName: "Read", hostStatus: "revoked" })
        .reason_code,
    ).toBe("host_revoked");
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Read",
        session: { cancelled: "budget" },
      }).reason_code,
    ).toBe("session_cancelled");
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Read",
        session: { paused: "review" },
      }).reason_code,
    ).toBe("session_paused");
  });

  it("fails closed on an unverified bundle in enforce mode and allows in observe", () => {
    expect(
      evaluatePreToolUse({ ...base, toolName: "Read", bundleVerified: false }),
    ).toMatchObject({
      decision: "deny",
      reason_code: "bundle_unverified",
    });
    const observe = signer.sign(unsignedBundle({ mode: "observe" }));
    expect(
      evaluatePreToolUse({
        ...base,
        bundle: observe,
        toolName: "Read",
        bundleVerified: false,
      }),
    ).toMatchObject({
      decision: "allow",
      evaluated: "defer",
    });
  });

  it("treats a newer deny generation or an expired bundle as stale", () => {
    const stale = { ...base, latestDenyGeneration: { org: 2, workspace: 1 } };
    expect(evaluatePreToolUse({ ...stale, toolName: "Read" })).toMatchObject({
      decision: "allow",
      stale: true,
    });
    expect(
      evaluatePreToolUse({
        ...stale,
        toolName: "Bash",
        toolInput: { command: "ls" },
      }),
    ).toMatchObject({
      decision: "defer",
      reason_code: "bundle_stale",
    });
    expect(
      evaluatePreToolUse({
        ...stale,
        toolName: "Bash",
        toolInput: { command: "ls" },
        controlReachable: false,
      }),
    ).toMatchObject({
      decision: "deny",
      reason_code: "bundle_stale",
      stale: true,
    });
    const expired = {
      ...base,
      bundle: signer.sign(
        unsignedBundle({ expires_at: "2020-01-01T00:00:00.000Z" }),
      ),
    };
    expect(
      evaluatePreToolUse({
        ...expired,
        toolName: "Write",
        toolInput: { file_path: "/repo/x" },
      }).decision,
    ).toBe("defer");
    const observeStale = {
      ...stale,
      bundle: signer.sign(unsignedBundle({ mode: "observe" })),
      controlReachable: false,
    };
    expect(
      evaluatePreToolUse({
        ...observeStale,
        toolName: "Bash",
        toolInput: { command: "ls" },
      }),
    ).toMatchObject({
      decision: "allow",
      evaluated: "deny",
    });
  });

  it("applies deny, then allow, then ask, then falls through", () => {
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Bash",
        toolInput: { command: "git push origin" },
      }),
    ).toMatchObject({
      decision: "deny",
      rule: "Bash(git push*)",
      reason_code: "rule_deny",
      risk_grade: "high",
    });
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Bash",
        toolInput: { command: "git status" },
      }),
    ).toMatchObject({
      decision: "allow",
      rule: "Bash(git status*)",
      reason_code: "rule_allow",
    });
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Bash",
        toolInput: { command: "rm -rf x" },
      }),
    ).toMatchObject({
      decision: "ask",
      rule: "Bash(rm *)",
      reason_code: "rule_ask",
    });
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Bash",
        toolInput: { command: "make" },
      }),
    ).toMatchObject({
      decision: "ask",
      reason_code: "no_rule",
    });
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Read",
        toolInput: { file_path: "/repo/a" },
      }),
    ).toMatchObject({
      decision: "allow",
      read_only: true,
      risk_grade: "low",
    });
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Edit",
        toolInput: { file_path: "/repo/a" },
      }),
    ).toMatchObject({
      decision: "ask",
      read_only: false,
      risk_grade: "medium",
    });
  });

  it("records the evaluation but answers allow in observe mode", () => {
    const observe = signer.sign(unsignedBundle({ mode: "observe" }));
    expect(
      evaluatePreToolUse({
        ...base,
        bundle: observe,
        toolName: "Bash",
        toolInput: { command: "git push" },
      }),
    ).toMatchObject({
      decision: "allow",
      evaluated: "deny",
      rule: "Bash(git push*)",
    });
    expect(
      evaluatePreToolUse({
        ...base,
        bundle: observe,
        toolName: "Bash",
        toolInput: { command: "make" },
      }),
    ).toMatchObject({
      decision: "allow",
      evaluated: "ask",
    });
    // Operator state still applies in observe mode: it is control, not policy.
    expect(
      evaluatePreToolUse({
        ...base,
        bundle: observe,
        toolName: "Read",
        hostStatus: "paused",
      }).decision,
    ).toBe("deny");
  });
});
