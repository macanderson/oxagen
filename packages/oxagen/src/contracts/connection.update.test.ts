import { describe, expect, it } from "vitest";
import { connectionUpdate } from "./connection.update";
import { getCapability } from "../registry";

describe("connection.update capability", () => {
  it("parses a rename input", () => {
    const parsed = connectionUpdate.input.parse({
      connectionId: "con_1",
      displayName: "Prod GitHub",
    });
    expect(parsed.displayName).toBe("Prod GitHub");
  });

  it("accepts null to clear deliveryConfig", () => {
    const parsed = connectionUpdate.input.parse({
      connectionId: "con_1",
      deliveryConfig: null,
    });
    expect(parsed.deliveryConfig).toBeNull();
  });

  it("rejects a missing connectionId", () => {
    expect(() => connectionUpdate.input.parse({ displayName: "x" })).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("update_connection")).toBe(connectionUpdate);
  });
});
