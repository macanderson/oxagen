import { describe, it, expect, vi } from "vitest";

// Regression for the empty-registry bug: the package's "./connectors"
// subpath used to resolve to types.ts (registry primitives only), so every
// consumer that imported `getConnector` from "@oxagen/ingestion/connectors"
// — including the connection.create handler behind POST /v1/.../connections
// — saw zero registered connectors and threw "No connector registered for
// 'github'" at runtime. The subpath must resolve to the registration barrel,
// making registration a side effect of the import itself.
import { getConnector, listConnectors, registerConnector } from "@oxagen/ingestion/connectors";
import type { ConnectorDefinition } from "@oxagen/ingestion/connectors";

describe("@oxagen/ingestion/connectors subpath", () => {
  it("registers built-in connectors as a side effect of the import", () => {
    expect(getConnector("github").connectorId).toBe("github");
    expect(listConnectors().length).toBeGreaterThanOrEqual(15);
  });

  it("treats duplicate registration as benign (bundler/HMR artifact), keeping the first", () => {
    const original = getConnector("github");
    const impostor = { ...original, displayName: "impostor" } as ConnectorDefinition;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => registerConnector(impostor)).not.toThrow();
      expect(getConnector("github")).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });
});
