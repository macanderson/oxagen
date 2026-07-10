/**
 * default-agent-optimistic.test.ts — the optimistic default-agent decision.
 *
 * Covers the two branches chat-shell-client relies on:
 *   - success → keep the optimistically-applied id;
 *   - failure → revert to the server-confirmed default (NOT the pre-toggle value).
 */
import { describe, it, expect } from "vitest";
import { resolveOptimisticDefaultAgent } from "./default-agent-optimistic";

describe("resolveOptimisticDefaultAgent", () => {
  it("keeps the attempted id when the action succeeds", () => {
    expect(
      resolveOptimisticDefaultAgent({ ok: true }, "agt_new", "agt_old"),
    ).toBe("agt_new");
  });

  it("reverts to the server-confirmed default when the action fails", () => {
    expect(
      resolveOptimisticDefaultAgent({ ok: false }, "agt_new", "agt_old"),
    ).toBe("agt_old");
  });

  it("reverts to the SERVER default, not the pre-toggle attempt, on failure", () => {
    // The attempted id must never leak through on failure — even a rapid
    // double-toggle settles on the server-confirmed anchor.
    expect(
      resolveOptimisticDefaultAgent({ ok: false }, "agt_stale", "agt_server"),
    ).toBe("agt_server");
  });

  it("keeps a cleared (null) selection when clearing succeeds", () => {
    expect(resolveOptimisticDefaultAgent({ ok: true }, null, "agt_old")).toBe(
      null,
    );
  });

  it("reverts a failed clear back to the server default", () => {
    expect(resolveOptimisticDefaultAgent({ ok: false }, null, "agt_old")).toBe(
      "agt_old",
    );
  });

  it("settles on null when the server has no confirmed default and the set fails", () => {
    expect(resolveOptimisticDefaultAgent({ ok: false }, "agt_new", null)).toBe(
      null,
    );
  });
});
