import { describe, expect, it } from "vitest";
import { runExport } from "./run.export";

describe("export_run contract", () => {
  it("is an async write restricted to org Owner and Admin, never metered as a governed action", () => {
    expect(runExport.mode).toBe("async");
    expect(runExport.mutates).toBe(true);
    expect(runExport.noBillingGate).toBe(true);
    expect(runExport.sensitivity).toBe("high");
    expect(runExport.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(runExport.agent?.requiresApproval).toBe(false);
  });

  it("takes a run id from either store and answers the queued export id", () => {
    expect(
      runExport.input.safeParse({ runId: "arun_5f0c2e9a1b7d4c3e8f6a02" })
        .success,
    ).toBe(true);
    expect(runExport.input.safeParse({ runId: "tse_0a1b2c" }).success).toBe(
      true,
    );
    expect(runExport.input.safeParse({ runId: "rexp_1" }).success).toBe(false);
    expect(
      runExport.output.safeParse({ exportId: "rexp_0a1b2c", status: "queued" })
        .success,
    ).toBe(true);
    expect(
      runExport.output.safeParse({ exportId: "rexp_0a1b2c", status: "ready" })
        .success,
    ).toBe(false);
  });
});
