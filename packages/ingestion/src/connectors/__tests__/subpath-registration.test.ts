import { describe, it, expect, vi } from "vitest";

// The package's "./connectors" subpath must resolve to the registration
// barrel, not to types.ts (registry primitives only), so importing
// `getConnector` from "@oxagen/ingestion/connectors" — as the
// connection.create handler behind POST /v1/.../connections does — always
// sees every built-in connector registered as a side effect of the import.
import {
  getConnector,
  listConnectors,
  registerConnector,
} from "@oxagen/ingestion/connectors";
import type { ConnectorDefinition } from "@oxagen/ingestion/connectors";

describe("@oxagen/ingestion/connectors subpath", () => {
  it("registers built-in connectors as a side effect of the import", () => {
    expect(getConnector("github").connectorId).toBe("github");
    expect(listConnectors().length).toBeGreaterThanOrEqual(15);
  });

  it("treats duplicate registration as benign (bundler/HMR artifact), keeping the first", () => {
    const original = getConnector("github");
    const impostor = {
      ...original,
      displayName: "impostor",
    } as ConnectorDefinition;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => registerConnector(impostor)).not.toThrow();
      expect(getConnector("github")).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });
});
