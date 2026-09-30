import { describe, expect, it } from "vitest";
import { admitVerifyStage, type GatewaySession, VERIFY_PROBLEM_CODES } from "./verify";

const verify: GatewaySession = { sessionId: "s-verify", tier: "contained", models: ["verify-route"] };
const fix: GatewaySession = { sessionId: "s-fix-1", tier: "harness", models: ["build-b", "build-a"] };

describe("admitVerifyStage", () => {
  it("admits a contained run on a model no build stage used", () => {
    const admission = admitVerifyStage({
      verifySessionId: "s-verify",
      verify,
      builds: [{ role: "Fix", sessionId: "s-fix-1", record: fix }],
    });
    expect(admission).toEqual({ admitted: true, verifyModels: ["verify-route"], buildModels: ["build-a", "build-b"] });
  });

  it("refuses a verify session the gateway has no record of", () => {
    const admission = admitVerifyStage({ verifySessionId: "s-verify", verify: null, builds: [] });
    expect(admission).toEqual({
      admitted: false,
      problems: [
        {
          code: "verify_unrecorded",
          sessionId: "s-verify",
          message: "The gateway holds no record of verify session s-verify.",
        },
      ],
    });
  });

  it("refuses a verify run outside a contained runtime, and one with no model recorded", () => {
    const admission = admitVerifyStage({
      verifySessionId: "s-verify",
      verify: { ...verify, tier: "gateway", models: [] },
      builds: [],
    });
    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.problems.map((problem) => problem.code)).toEqual(["not_contained", "no_model_recorded"]);
    expect(admission.problems[0]?.message).toBe(
      "Verify session s-verify ran at the gateway tier. A verify stage runs contained.",
    );
  });

  it("refuses when a build session has no record, because the models cannot be compared", () => {
    const admission = admitVerifyStage({
      verifySessionId: "s-verify",
      verify,
      builds: [{ role: "Fix", sessionId: "s-fix-2", record: null }],
    });
    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.problems).toEqual([
      {
        code: "build_unrecorded",
        sessionId: "s-fix-2",
        message:
          "The gateway holds no record of Fix session s-fix-2, so the verify model cannot be compared with it.",
      },
    ]);
  });

  it("refuses a verify run on a model a build stage used, whatever the workflow file pins", () => {
    const admission = admitVerifyStage({
      verifySessionId: "s-verify",
      verify: { ...verify, models: ["verify-route", "build-a"] },
      builds: [
        { role: "Fix", sessionId: "s-fix-1", record: fix },
        { role: "Fix", sessionId: "s-fix-2", record: { sessionId: "s-fix-2", tier: "harness", models: [] } },
      ],
    });
    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.problems).toEqual([
      {
        code: "shared_model",
        sessionId: "s-verify",
        message:
          "Verify session s-verify used build-a, which a build stage also used. A verify stage runs on a model no build stage used.",
      },
    ]);
  });

  it("names every problem code it can return", () => {
    expect(VERIFY_PROBLEM_CODES).toEqual([
      "verify_unrecorded",
      "not_contained",
      "no_model_recorded",
      "build_unrecorded",
      "shared_model",
    ]);
  });
});
