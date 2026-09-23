import { describe, expect, it } from "vitest";
import {
  evaluatePreToolUse,
  globToRegex,
  parseRule,
  ruleMatches,
  verifyBundle,
} from "./bundle";
import { CONTAINMENT_REQUIRED_REASON } from "../collector/hook-handler";
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

  it("keeps a confirmed mandate fresh past its own expires_at", () => {
    // The defect this covers, and it is a live one in enforce mode. The etag
    // covers policy content only, so an unchanged mandate answers
    // `not_modified` on every poll and the host keeps the bundle it has.
    // `expires_at` is inside the signature and cannot be renewed locally. So
    // judging freshness by `expires_at` declares a healthy host stale 24
    // hours after the last policy edit, and it stays stale until someone
    // edits the policy again: every mutating tool call denied, fleet wide.
    const issued = Date.parse("2026-09-10T00:00:00.000Z");
    const expires = Date.parse("2026-09-11T00:00:00.000Z");
    const dayOld = {
      ...base,
      bundle: signer.sign(
        unsignedBundle({
          issued_at: new Date(issued).toISOString(),
          expires_at: new Date(expires).toISOString(),
        }),
      ),
      // Two days after it was issued, so `expires_at` is well past.
      now: issued + 2 * 24 * 60 * 60_000,
    };
    // Allowed by rule, and not read-only, so the freshness gate is what
    // decides it rather than a permission miss.
    const write = { toolName: "Bash", toolInput: { command: "git status" } };

    // Confirmed an hour ago: the mandate is current, whatever the clock says
    // about a timestamp the host cannot renew.
    expect(
      evaluatePreToolUse({
        ...dayOld,
        ...write,
        mandateConfirmedAt: dayOld.now - 60 * 60_000,
      }).decision,
    ).toBe("allow");

    // Not confirmed for longer than the bundle's own signed window: stale,
    // which is what the window is for.
    expect(
      evaluatePreToolUse({
        ...dayOld,
        ...write,
        mandateConfirmedAt: dayOld.now - 25 * 60 * 60_000,
      }),
    ).toMatchObject({ decision: "defer", reason_code: "bundle_stale" });

    // No confirmation recorded reads exactly as it did before, measuring
    // from `issued_at`, so a caller that predates this changes nothing.
    expect(evaluatePreToolUse({ ...dayOld, ...write }).decision).toBe("defer");
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

  it("applies deny, then ask, then allow, then falls through", () => {
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

describe("PreToolUse evaluation for a mandate that requires the contained tier (ADR-152)", () => {
  const signer = bundleSigner();
  const bundle = signer.sign(
    unsignedBundle({ containment: { required: true } }),
  );
  const base = {
    bundle,
    bundleVerified: true,
    hostStatus: "active" as const,
    latestDenyGeneration: { org: 1, workspace: 1 },
    controlReachable: true,
    now: NOW,
    context: { cwd: "/repo" },
  };

  it("denies even a read-only tool the rules allow, with the hook's own reason", () => {
    // `Read` is on the allow list and read-only, so nothing but containment
    // can deny it here.
    expect(evaluatePreToolUse({ ...base, toolName: "Read" }).decision).toBe(
      "allow",
    );
    expect(
      evaluatePreToolUse({ ...base, toolName: "Read", containmentUnmet: true }),
    ).toMatchObject({
      decision: "deny",
      evaluated: "deny",
      source: "bundle",
      reason_code: "containment_required",
      reason: CONTAINMENT_REQUIRED_REASON,
    });
  });

  it("denies before freshness, so a stale bundle cannot defer it to a refresh", () => {
    const stale = { ...base, latestDenyGeneration: { org: 2, workspace: 1 } };
    const write = { toolName: "Bash", toolInput: { command: "git status" } };
    expect(evaluatePreToolUse({ ...stale, ...write }).decision).toBe("defer");
    expect(
      evaluatePreToolUse({ ...stale, ...write, containmentUnmet: true }),
    ).toMatchObject({
      decision: "deny",
      reason_code: "containment_required",
      stale: false,
    });
  });

  it("reports an unverified bundle as unverified first", () => {
    // Enforce: the unverified bundle already fails closed, and the reason
    // says why rather than naming a requirement nobody could verify.
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Read",
        bundleVerified: false,
        containmentUnmet: true,
      }),
    ).toMatchObject({ decision: "deny", reason_code: "bundle_unverified" });
    // Observe: an unverified bundle allows, and an unverifiable containment
    // requirement does not turn that into a deny.
    const observe = signer.sign(
      unsignedBundle({ mode: "observe", containment: { required: true } }),
    );
    expect(
      evaluatePreToolUse({
        ...base,
        bundle: observe,
        toolName: "Read",
        bundleVerified: false,
        containmentUnmet: true,
      }),
    ).toMatchObject({
      decision: "allow",
      evaluated: "defer",
      reason_code: "bundle_unverified",
    });
  });

  it("leaves operator state first: a paused host or cancelled session says so", () => {
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Read",
        hostStatus: "paused",
        containmentUnmet: true,
      }),
    ).toMatchObject({ source: "human", reason_code: "host_paused" });
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Read",
        session: { cancelled: "budget" },
        containmentUnmet: true,
      }),
    ).toMatchObject({ source: "human", reason_code: "session_cancelled" });
  });

  it("never refuses under an observe bundle, even when a caller sets the flag", () => {
    // The evaluator checks the mode itself rather than trusting its caller,
    // so an observe host records and never refuses.
    const observe = signer.sign(
      unsignedBundle({ mode: "observe", containment: { required: true } }),
    );
    expect(
      evaluatePreToolUse({
        ...base,
        bundle: observe,
        toolName: "Read",
        containmentUnmet: true,
      }).reason_code,
    ).not.toBe("containment_required");
  });
});

describe("verifying a bundle that carries a containment requirement", () => {
  it("fails verification when the requirement is stripped or added after signing", () => {
    // The requirement is inside the signature, so a host whose bundle was
    // edited to drop it fails closed as unverified instead of running the
    // agent uncontained.
    const signer = bundleSigner();
    const required = signer.sign(
      unsignedBundle({ containment: { required: true } }),
    );
    expect(verifyBundle(required, signer.publicKeyPem).ok).toBe(true);
    const stripped = { ...required };
    delete stripped.containment;
    expect(verifyBundle(stripped, signer.publicKeyPem)).toMatchObject({
      ok: false,
      reason: "signature does not verify",
    });
    const plain = signer.sign(unsignedBundle());
    expect(
      verifyBundle(
        { ...plain, containment: { required: true } },
        signer.publicKeyPem,
      ).ok,
    ).toBe(false);
  });
});

/**
 * A mandate is written once and enforced on every harness. Cursor spells the
 * shell tool `Shell` where Claude Code spells it `Bash` (verified 2026-09-18
 * against https://cursor.com/docs/agent/hooks, fetched that day), and a rule
 * that did not reach across the two spellings would not apply to Cursor at
 * all while the record still said allow.
 */
describe("a rule written for Bash reaches Cursor's Shell", () => {
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

  it("denies a Shell push under the bundle's Bash(git push*) rule", () => {
    const denied = evaluatePreToolUse({
      ...base,
      toolName: "Shell",
      toolInput: { command: "git push origin main" },
    });
    expect(denied.decision).toBe("deny");
    expect(denied.rule).toBe("Bash(git push*)");
    // And the same call under Claude Code's spelling, unchanged.
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Bash",
        toolInput: { command: "git push origin main" },
      }).decision,
    ).toBe("deny");
  });

  it("asks for a Shell rm under the bundle's Bash(rm *) rule", () => {
    // Cursor does not enforce an ask at preToolUse, so the adapter degrades
    // it to a deny. The evaluation still has to reach the rule, or there
    // would be nothing to degrade.
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Shell",
        toolInput: { command: "rm -rf /repo" },
      }).decision,
    ).toBe("ask");
  });

  it("takes the declared tool facts from the Bash entry", () => {
    // `bundle.tools` is keyed by Claude Code's names, so a Shell call would
    // otherwise be graded from the classifier's default rather than from the
    // grade the workspace set for its shell.
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Shell",
        toolInput: { command: "git status" },
      }),
    ).toMatchObject({ risk_grade: "high", read_only: false });
  });
});
