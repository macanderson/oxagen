import { describe, expect, it } from "vitest";
import {
  flowHref,
  gateAgentChoice,
  gateHref,
  readAgentChoice,
  readGateQuery,
  registerHref,
} from "./flow-links";

describe("gate links", () => {
  it("keeps the first step bare and carries org and workspace after it", () => {
    expect(gateHref("organization", null)).toBe("/welcome");
    expect(gateHref("wrap", { org: "acme", ws: "core-platform" })).toBe(
      "/welcome/wrap?org=acme&ws=core-platform",
    );
  });

  it("reads org and workspace, refusing a partial query", () => {
    expect(readGateQuery({ org: "acme", ws: ["core-platform", "x"] })).toEqual({
      org: "acme",
      ws: "core-platform",
    });
    expect(readGateQuery({ org: "acme" })).toBeNull();
  });

  it("derives the gate's agent from the harness, defaulting to Claude Code", () => {
    expect(gateAgentChoice({})).toEqual({
      agent: "claude-code",
      harness: "claude-code",
      tier: "complex",
    });
    expect(gateAgentChoice({ harness: "stella" })).toEqual({
      agent: "sdk-agent",
      harness: "stella",
      tier: "complex",
    });
    expect(gateAgentChoice({ harness: "evil" }).harness).toBe("claude-code");
  });
});

describe("register links", () => {
  const choice = {
    agent: "perf-watch",
    harness: "codex-cli",
    tier: "light",
  } as const;

  it("carries the agent choice after the name step", () => {
    expect(registerHref("acme", "core-platform", "name", choice)).toBe(
      "/acme/core-platform/register?agent=perf-watch&harness=codex-cli&tier=light",
    );
    expect(registerHref("acme", "core-platform", "run", choice)).toBe(
      "/acme/core-platform/register/run?agent=perf-watch&harness=codex-cli&tier=light",
    );
  });

  it("reads a valid choice and refuses a malformed one", () => {
    expect(
      readAgentChoice({ agent: "perf-watch", harness: "codex-cli" }),
    ).toEqual({
      agent: "perf-watch",
      harness: "codex-cli",
      tier: "complex",
    });
    expect(
      readAgentChoice({ agent: "Perf Watch", harness: "codex-cli" }),
    ).toBeNull();
    expect(
      readAgentChoice({ agent: "perf-watch", harness: "curl" }),
    ).toBeNull();
    expect(
      readAgentChoice({ agent: "perf-watch", harness: "custom", tier: "huge" }),
    ).toBeNull();
  });

  it("builds a step link for either flow", () => {
    expect(
      flowHref("gate", "organization", {
        org: "acme",
        ws: "core-platform",
        choice: null,
      }),
    ).toBe("/welcome");
    expect(
      flowHref("gate", "run", {
        org: "acme",
        ws: "core-platform",
        choice: null,
      }),
    ).toBe("/welcome/run?org=acme&ws=core-platform");
    expect(
      flowHref("register", "name", {
        org: "acme",
        ws: "core-platform",
        choice,
      }),
    ).toBe("/acme/core-platform/register");
  });
});
