import { describe, it, expect } from "vitest";

// Import index.ts which auto-registers all 15 built-in connectors.
// This must happen before calling getConnector/listConnectors.
import "../../index";
import { getConnector, listConnectors } from "../types";

const EXPECTED_CONNECTOR_IDS = [
  "github",
  "google-drive",
  "google-calendar",
  "google-gmail",
  "google-contacts",
  "google-bigquery",
  "google-meet",
  "google-tasks",
  "zoom",
  "linear",
  "slack",
  "salesforce",
  "microsoft",
  "custom-sql",
  "custom-webhook",
];

describe("connector registry", () => {
  it("has all 15 built-in connectors registered", () => {
    const ids = listConnectors().map((c) => c.connectorId);
    for (const expected of EXPECTED_CONNECTOR_IDS) {
      expect(ids).toContain(expected);
    }
    expect(ids.length).toBeGreaterThanOrEqual(15);
  });

  it("getConnector returns the correct connector by id", () => {
    const github = getConnector("github");
    expect(github.connectorId).toBe("github");
    expect(github.displayName).toBe("GitHub");
  });

  it("getConnector returns google-drive connector", () => {
    const c = getConnector("google-drive");
    expect(c.connectorId).toBe("google-drive");
  });

  it("getConnector throws for unknown connector", () => {
    expect(() => getConnector("nonexistent-connector")).toThrow(
      'No connector registered for "nonexistent-connector"',
    );
  });

  it("listConnectors returns ConnectorDefinition objects with required fields", () => {
    const connectors = listConnectors();
    for (const c of connectors) {
      expect(typeof c.connectorId).toBe("string");
      expect(typeof c.displayName).toBe("string");
      expect(typeof c.description).toBe("string");
      expect(Array.isArray(c.supportedAuthSchemes)).toBe(true);
      expect(typeof c.deliveryMethod).toBe("string");
      expect(typeof c.normalizeRecord).toBe("function");
    }
  });

  it("each connector has a connectionConfigSchema with parse method", () => {
    const connectors = listConnectors();
    for (const c of connectors) {
      expect(typeof c.connectionConfigSchema.parse).toBe("function");
    }
  });

  // Security invariant: the /webhooks route's verification gate fails CLOSED for
  // any webhook-delivery connector that omits verifyWebhook. Enforce here so a
  // new webhook connector cannot silently reintroduce the fail-open bypass.
  it("every webhook-delivery connector implements verifyWebhook", () => {
    const connectors = listConnectors();
    const webhookConnectors = connectors.filter(
      (c) => c.deliveryMethod === "webhook",
    );
    expect(webhookConnectors.length).toBeGreaterThan(0);
    for (const c of webhookConnectors) {
      expect(
        typeof c.verifyWebhook,
        `connector "${c.connectorId}" declares deliveryMethod "webhook" but has no verifyWebhook`,
      ).toBe("function");
    }
  });
});
