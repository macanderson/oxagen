import { describe, expect, it } from "vitest";
import { connectionPause } from "./connection.pause";
import { getCapability } from "../registry";

describe("connection.pause capability", () => {
  it("parses a pause input", () => {
    const parsed = connectionPause.input.parse({
      connectionId: "con_1",
      paused: true,
    });
    expect(parsed.paused).toBe(true);
  });

  it("requires the paused flag", () => {
    expect(() =>
      connectionPause.input.parse({ connectionId: "con_1" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = connectionPause.output.parse({
      connectionId: "con_1",
      status: "paused",
    });
    expect(out.status).toBe("paused");
  });

  it("rejects an invalid status in output", () => {
    expect(() =>
      connectionPause.output.parse({ connectionId: "con_1", status: "error" }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("pause_connection")).toBe(connectionPause);
  });
});
