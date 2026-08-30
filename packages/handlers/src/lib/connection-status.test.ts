import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture eq/or calls to assert the predicate-shape branching of
// sourceConnectionRefCondition without depending on Drizzle SQL internals.
const dz = vi.hoisted(() => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
  or: vi.fn((...conds: unknown[]) => ({ __or: conds })),
}));
const ext = vi.hoisted(() => ({
  loadBuiltInSchema: vi.fn(),
  platformVersion: vi.fn(() => "9.9.9"),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, eq: dz.eq, or: dz.or };
});
vi.mock("@oxagen/ingestion/connector-schema-loader", () => ({
  loadBuiltInSchema: ext.loadBuiltInSchema,
}));
vi.mock("@oxagen/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/config")>();
  return { ...real, platformVersion: ext.platformVersion };
});

import { schema } from "@oxagen/database";
import {
  DB_STATUS_TO_CONTRACT_STATUS,
  CONTRACT_STATUS_TO_DB_STATUS,
  toContractStatus,
  resolveConnectorVersion,
  sourceConnectionRefCondition,
} from "./connection-status";

describe("connection-status helpers", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("toContractStatus", () => {
    it("maps every DB status to its contract status", () => {
      expect(toContractStatus("connected")).toBe("active");
      expect(toContractStatus("paused")).toBe("paused");
      expect(toContractStatus("error")).toBe("failed");
      expect(toContractStatus("pending_setup")).toBe("pending_setup");
      // deleting/deleted collapse to pending_setup (no live data to report).
      expect(toContractStatus("deleting")).toBe("pending_setup");
      expect(toContractStatus("deleted")).toBe("pending_setup");
    });

    it("falls back to pending_setup for an unknown status", () => {
      expect(toContractStatus("something_new")).toBe("pending_setup");
    });

    it("keeps the two maps consistent for the round-trippable states", () => {
      expect(DB_STATUS_TO_CONTRACT_STATUS["connected"]).toBe("active");
      expect(CONTRACT_STATUS_TO_DB_STATUS["active"]).toBe("connected");
      expect(CONTRACT_STATUS_TO_DB_STATUS["failed"]).toBe("error");
      expect(CONTRACT_STATUS_TO_DB_STATUS["paused"]).toBe("paused");
      expect(CONTRACT_STATUS_TO_DB_STATUS["pending_setup"]).toBe(
        "pending_setup",
      );
    });
  });

  describe("resolveConnectorVersion", () => {
    it("returns the connector's bundled schema version when available", () => {
      ext.loadBuiltInSchema.mockReturnValue({ metadata: { version: "2.4.1" } });
      expect(resolveConnectorVersion("github")).toBe("2.4.1");
      expect(ext.platformVersion).not.toHaveBeenCalled();
    });

    it("falls back to the platform version when the connector has no bundled schema", () => {
      ext.loadBuiltInSchema.mockReturnValue(null);
      expect(resolveConnectorVersion("custom-webhook")).toBe("9.9.9");
      expect(ext.platformVersion).toHaveBeenCalled();
    });

    it("uses the platform version when no connectorId is given", () => {
      expect(resolveConnectorVersion()).toBe("9.9.9");
      expect(ext.loadBuiltInSchema).not.toHaveBeenCalled();
    });
  });

  describe("sourceConnectionRefCondition", () => {
    it("matches BOTH publicId and id (via or) for a UUID ref", () => {
      const uuid = "6efa8e26-48b6-4506-9bc1-3e7820887b37";
      sourceConnectionRefCondition(uuid);
      expect(dz.or).toHaveBeenCalledTimes(1);
      expect(dz.eq).toHaveBeenCalledWith(
        schema.sourceConnections.publicId,
        uuid,
      );
      expect(dz.eq).toHaveBeenCalledWith(schema.sourceConnections.id, uuid);
      expect(dz.eq).toHaveBeenCalledTimes(2);
    });

    it("matches ONLY publicId (no or, no id-cast) for a non-UUID public ref", () => {
      sourceConnectionRefCondition("con_abc123");
      expect(dz.or).not.toHaveBeenCalled();
      expect(dz.eq).toHaveBeenCalledTimes(1);
      expect(dz.eq).toHaveBeenCalledWith(
        schema.sourceConnections.publicId,
        "con_abc123",
      );
    });
  });
});
