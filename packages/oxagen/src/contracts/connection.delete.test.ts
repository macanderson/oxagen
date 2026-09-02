import { describe, expect, it } from "vitest";
import { connectionDelete } from "./connection.delete";
import { getCapability } from "../registry";

describe("connection.delete capability", () => {
  it("defaults mode to full", () => {
    const parsed = connectionDelete.input.parse({ connectionId: "con_ABC" });
    expect(parsed.mode).toBe("full");
  });

  it("parses connection_only mode", () => {
    const parsed = connectionDelete.input.parse({
      connectionId: "con_ABC",
      mode: "connection_only",
    });
    expect(parsed.mode).toBe("connection_only");
  });

  it("parses data_only mode", () => {
    const parsed = connectionDelete.input.parse({
      connectionId: "con_ABC",
      mode: "data_only",
    });
    expect(parsed.mode).toBe("data_only");
  });

  it("rejects unknown mode", () => {
    expect(() =>
      connectionDelete.input.parse({
        connectionId: "con_ABC",
        mode: "nuclear",
      }),
    ).toThrow();
  });

  it("rejects empty connectionId", () => {
    expect(() => connectionDelete.input.parse({ connectionId: "" })).toThrow();
  });

  it("parses valid output", () => {
    const parsed = connectionDelete.output.parse({
      deletionJobId: "djob_xyz",
      mode: "full",
      status: "running",
    });
    expect(parsed.status).toBe("running");
    expect(parsed.deletionJobId).toBe("djob_xyz");
    expect(parsed.mode).toBe("full");
  });

  it("rejects wrong output status", () => {
    expect(() =>
      connectionDelete.output.parse({
        deletionJobId: "djob_xyz",
        mode: "full",
        status: "done",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("delete_connection")).toBe(connectionDelete);
  });

  it("is async mode", () => {
    expect(connectionDelete.mode).toBe("async");
  });

  it("requires approval and is destructive category", () => {
    expect(connectionDelete.agent?.requiresApproval).toBe(true);
    expect(connectionDelete.agent?.category).toBe("destructive");
    expect(connectionDelete.agent?.riskLevel).toBe("high");
  });

  it("has high sensitivity", () => {
    expect(connectionDelete.sensitivity).toBe("high");
  });
});
