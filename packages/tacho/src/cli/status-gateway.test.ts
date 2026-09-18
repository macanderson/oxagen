/**
 * What `tacho status` says about the gateway. The tier word comes from what
 * the daemon saw routed (ADR-095), never from what is installed.
 */
import { describe, expect, it } from "vitest";
import { gatewayOf, observedTiers } from "./status";

describe("the gateway block", () => {
  it("is passed on when the daemon reports a well-formed one", () => {
    expect(
      gatewayOf({
        gateway: {
          listening: true,
          port: 47124,
          routes: ["/anthropic", 7],
          calls_observed: 3,
        },
      }),
    ).toEqual({
      listening: true,
      port: 47124,
      routes: ["/anthropic"],
      calls_observed: 3,
    });
    expect(gatewayOf({ gateway: { listening: false, port: 1 } })).toEqual({
      listening: false,
      port: 1,
      routes: [],
      calls_observed: 0,
    });
  });

  it("is absent for a daemon that is down, predates the proxy, or sends something else", () => {
    expect(gatewayOf(null)).toBeUndefined();
    expect(gatewayOf({})).toBeUndefined();
    expect(gatewayOf({ gateway: "yes" })).toBeUndefined();
    expect(
      gatewayOf({ gateway: { listening: "true", port: 1 } }),
    ).toBeUndefined();
  });
});

describe("the tier a harness earned", () => {
  it("is the highest its sessions reached, and nothing for a harness with no run", () => {
    expect(
      observedTiers({
        sessions: [
          { harness: "claude-code", enforcement_tier: "harness" },
          { harness: "claude-code", enforcement_tier: "gateway" },
          { harness: "claude-code", enforcement_tier: "observe" },
          { harness: "codex", enforcement_tier: "observe" },
          { harness: "stella", enforcement_tier: "contained" },
          { harness: 4, enforcement_tier: "gateway" },
          { harness: "codex" },
        ],
      }),
    ).toEqual({ "claude-code": "gateway", codex: "observe" });
    expect(observedTiers(null)).toEqual({});
    expect(observedTiers({ sessions: "none" })).toEqual({});
  });
});
