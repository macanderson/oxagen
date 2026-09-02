import { describe, expect, it } from "vitest";
import { evalRunStart } from "./eval.run.start";
import { getCapability } from "../registry";

describe("eval.run.start capability", () => {
  it("parses a minimal valid input and applies defaults", () => {
    const parsed = evalRunStart.input.parse({
      datasetPublicId: "ds_pub_1",
      target: { kind: "model" },
    });
    expect(parsed.datasetPublicId).toBe("ds_pub_1");
    expect(parsed.target).toEqual({ kind: "model" });
    expect(parsed.passThreshold).toBe(0.7);
    expect(parsed.judgeModel).toBeUndefined();
    expect(parsed.name).toBeUndefined();
    expect(parsed.maxItems).toBeUndefined();
  });

  it("parses input with an agent target and all optional fields", () => {
    const parsed = evalRunStart.input.parse({
      datasetPublicId: "ds_pub_1",
      target: { kind: "agent", agentSlug: "my-agent" },
      judgeModel: "anthropic/claude-sonnet-5",
      name: "Weekly regression",
      passThreshold: 0.9,
      maxItems: 25,
    });
    expect(parsed.target).toEqual({ kind: "agent", agentSlug: "my-agent" });
    expect(parsed.judgeModel).toBe("anthropic/claude-sonnet-5");
    expect(parsed.passThreshold).toBe(0.9);
    expect(parsed.maxItems).toBe(25);
  });

  it("rejects a missing datasetPublicId", () => {
    expect(() =>
      evalRunStart.input.parse({ target: { kind: "model" } }),
    ).toThrow();
  });

  it("rejects a passThreshold over 1", () => {
    expect(() =>
      evalRunStart.input.parse({
        datasetPublicId: "ds_pub_1",
        target: { kind: "model" },
        passThreshold: 1.1,
      }),
    ).toThrow();
  });

  it("rejects a maxItems over 500", () => {
    expect(() =>
      evalRunStart.input.parse({
        datasetPublicId: "ds_pub_1",
        target: { kind: "model" },
        maxItems: 501,
      }),
    ).toThrow();
  });

  it("rejects an agent target missing agentSlug", () => {
    expect(() =>
      evalRunStart.input.parse({
        datasetPublicId: "ds_pub_1",
        target: { kind: "agent" },
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalRunStart.output.parse({
      runId: "run_1",
      status: "pending",
      itemCount: 10,
    });
    expect(out.status).toBe("pending");
  });

  it("rejects an output with a non-pending status", () => {
    expect(() =>
      evalRunStart.output.parse({
        runId: "run_1",
        status: "running",
        itemCount: 10,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("start_eval_run")).toBe(evalRunStart);
  });

  it("is billing-gated (does not set noBillingGate)", () => {
    // eval.run.start consumes AI tokens (target + judge), so it must NOT opt out
    // of the billing admission gate. The field is intentionally absent.
    expect(
      (evalRunStart as { noBillingGate?: boolean }).noBillingGate,
    ).not.toBe(true);
  });
});
