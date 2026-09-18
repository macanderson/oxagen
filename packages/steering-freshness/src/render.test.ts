import { describe, expect, it } from "vitest";
import {
  HARNESS_RENDERERS,
  renderBanner,
  renderGate,
  renderJson,
  renderText,
  renderUserPromptSubmit,
} from "./render";
import type { GateDecision } from "./gate";
import type { FreshnessVerdict } from "./check";
import { resolveSteeringPolicy } from "./policy";

function verdict(over: Partial<FreshnessVerdict> = {}): FreshnessVerdict {
  return {
    status: "behind",
    remote: "origin",
    branch: "main",
    missing: [{ status: "added", path: ".oxagen/rules/ctx.release.pin.toml" }],
    local: [],
    dirty: [],
    behindByCommits: 1,
    fingerprint: { local: "a", remote: "b" },
    fetch: { attempted: true, ok: true, reason: null },
    notes: [],
    platform: null,
    ...over,
  };
}

function decision(over: Partial<GateDecision> = {}): GateDecision {
  return {
    action: "warn",
    verdict: verdict(),
    policy: resolveSteeringPolicy([]),
    sync: null,
    exitCode: 0,
    ...over,
  };
}

describe("renderBanner", () => {
  it("says nothing on a clean prompt", () => {
    expect(
      renderBanner(
        decision({ action: "allow", verdict: verdict({ status: "current" }) }),
      ),
    ).toBe("");
  });

  it("names the count, the branch and each file when warning", () => {
    const banner = renderBanner(decision());
    expect(banner).toContain("1 record behind origin/main");
    expect(banner).toContain(".oxagen/rules/ctx.release.pin.toml");
    expect(banner).toContain("oxagen steering sync");
  });

  it("leads with the refusal when blocking", () => {
    const banner = renderBanner(
      decision({
        action: "block",
        policy: resolveSteeringPolicy([
          { scope: "workspace", policy: { blockStaleRuns: true } },
        ]),
        exitCode: 2,
      }),
    );
    expect(banner.startsWith("Run stopped.")).toBe(true);
    expect(banner).toContain("your Oxagen workspace");
    expect(banner).toContain("OXAGEN_STEERING_FRESHNESS=off");
  });

  it("tells a diverged checkout to reconcile rather than to sync", () => {
    const banner = renderBanner(
      decision({
        action: "block",
        verdict: verdict({
          status: "diverged",
          local: [{ status: "added", path: ".oxagen/rules/ctx.mine.toml" }],
        }),
        exitCode: 2,
      }),
    );
    expect(banner).toContain("reconciled by hand");
    expect(banner).not.toContain(
      "Run `oxagen steering sync`, then run the prompt again.",
    );
  });

  it("pluralises the record count", () => {
    const banner = renderBanner(
      decision({
        verdict: verdict({
          missing: [
            { status: "added", path: "a" },
            { status: "modified", path: "b" },
          ],
        }),
      }),
    );
    expect(banner).toContain("2 records behind");
  });

  it("truncates a long list rather than filling the transcript", () => {
    const missing = Array.from({ length: 25 }, (_, i) => ({
      status: "added" as const,
      path: `.oxagen/rules/ctx.${i}.toml`,
    }));
    const banner = renderBanner(decision({ verdict: verdict({ missing }) }));
    expect(banner).toContain("15 more");
    expect(banner).not.toContain("ctx.24.toml");
  });

  it("reports an auto-sync that ran", () => {
    const banner = renderBanner(
      decision({
        action: "allow",
        verdict: verdict({ status: "current", missing: [] }),
        sync: {
          applied: true,
          refusal: null,
          message: "Synced 1 file.",
          updated: ["a"],
          removed: [],
          fromCommit: "abc",
          committed: false,
        },
      }),
    );
    expect(banner).toContain("Oxagen synced .oxagen/");
  });

  it("reports an auto-sync that refused", () => {
    const banner = renderBanner(
      decision({
        sync: {
          applied: false,
          refusal: "dirty",
          message: "`.oxagen/` has uncommitted changes.",
          updated: [],
          removed: [],
          fromCommit: null,
          committed: false,
        },
      }),
    );
    expect(banner).toContain("Auto-sync did not run.");
  });

  it("carries the notes, so an offline check explains itself", () => {
    const banner = renderBanner(
      decision({ verdict: verdict({ notes: ["could not reach origin"] }) }),
    );
    expect(banner).toContain("could not reach origin");
  });

  // Brand rules for anything a person reads.
  it("uses no em dash and no semicolon", () => {
    for (const action of ["warn", "block"] as const) {
      const banner = renderBanner(
        decision({ action, exitCode: action === "block" ? 2 : 0 }),
      );
      expect(banner).not.toContain("—");
      expect(banner).not.toContain(";");
    }
  });
});

describe("renderText", () => {
  it("puts the banner on stderr and carries the exit code", () => {
    const out = renderText(decision({ action: "block", exitCode: 2 }));
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Run stopped.");
    expect(out.exitCode).toBe(2);
  });

  it("is silent when there is nothing to say", () => {
    const out = renderText(
      decision({ action: "allow", verdict: verdict({ status: "current" }) }),
    );
    expect(out.stderr).toBe("");
    expect(out.exitCode).toBe(0);
  });
});

describe("renderUserPromptSubmit", () => {
  // These field names are the whole contract. A typo here is a gate that
  // decides correctly and says nothing, in both harnesses.
  it("blocks in the shape Claude Code and Codex each read, and exits 2", () => {
    const out = renderUserPromptSubmit(
      decision({ action: "block", exitCode: 2 }),
    );
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload.decision).toBe("block");
    expect(payload.reason).toContain("Run stopped.");
    expect(payload.hookSpecificOutput).toMatchObject({
      hookEventName: "UserPromptSubmit",
      permissionDecision: "deny",
    });
    expect(
      (payload.hookSpecificOutput as Record<string, string>)
        .permissionDecisionReason,
    ).toContain("Run stopped.");
    expect(out.stderr).toContain("Run stopped.");
    expect(out.exitCode).toBe(2);
  });

  it("warns as additionalContext, so the model sees it in the transcript", () => {
    const out = renderUserPromptSubmit(decision());
    const payload = JSON.parse(out.stdout) as {
      hookSpecificOutput: Record<string, string>;
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "behind origin/main",
    );
    expect(payload.hookSpecificOutput.systemMessage).toContain(
      "behind origin/main",
    );
    expect(out.exitCode).toBe(0);
  });

  it("prints nothing at all on a clean prompt", () => {
    const out = renderUserPromptSubmit(
      decision({ action: "allow", verdict: verdict({ status: "current" }) }),
    );
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
  });

  it("emits one line of JSON, which is what a hook reads", () => {
    const out = renderUserPromptSubmit(decision());
    expect(out.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("renderJson", () => {
  it("carries the whole decision, including the banner", () => {
    const out = renderJson(decision());
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload.action).toBe("warn");
    expect(payload.status).toBe("behind");
    expect(payload.behindByRecords).toBe(1);
    expect(payload.banner).toContain("behind origin/main");
    expect(payload.policy).toMatchObject({ blockStaleRuns: false });
  });
});

describe("renderGate", () => {
  it.each(["claude-code", "codex"])(
    "renders %s through the shared UserPromptSubmit renderer",
    (harness) => {
      expect(HARNESS_RENDERERS[harness]).toBe("user-prompt-submit");
      const out = renderGate(decision(), harness);
      expect(out.stdout).toContain("hookSpecificOutput");
    },
  );

  // A harness this build has never heard of still gets the contract every
  // shell understands.
  it("falls back to text for an unknown harness", () => {
    const out = renderGate(
      decision({ action: "block", exitCode: 2 }),
      "some-new-agent",
    );
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Run stopped.");
    expect(out.exitCode).toBe(2);
  });
});

// The gate fails open on `unknown`, which is right. Rendering nothing made a
// skipped check look like a passed one.
describe("renderBanner, a check that could not run", () => {
  it("says the prompt ran unchecked, and why", () => {
    const text = renderBanner({
      action: "allow",
      verdict: verdict({
        status: "unknown",
        missing: [],
        notes: [
          'this repository has no remote named "evil", so the check did not run',
        ],
      }),
      policy: resolveSteeringPolicy([]),
      sync: null,
      exitCode: 0,
    });
    expect(text).toContain("ran unchecked");
    expect(text).toContain('no remote named "evil"');
  });
});

// Behind with nothing git can show: `steering sync` refuses that state, so the
// banner has to name the fetch first.
describe("renderBanner, when only the platform knows", () => {
  it("names the fetch, not just the sync", () => {
    const text = renderBanner({
      action: "block",
      verdict: verdict({ status: "behind", missing: [] }),
      policy: resolveSteeringPolicy([
        { scope: "workspace", policy: { blockStaleRuns: true } },
      ]),
      sync: null,
      exitCode: 2,
    });
    expect(text).toContain("git fetch origin");
  });
});
