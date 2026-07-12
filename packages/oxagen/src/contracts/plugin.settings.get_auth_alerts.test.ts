import { describe, expect, it } from "vitest";
import { pluginSettingsGetAuthAlerts } from "./plugin.settings.get_auth_alerts";
import { getCapability } from "../registry";

describe("plugin.settings.get_auth_alerts capability", () => {
  it("is registered under its name with the plugin domain", () => {
    const cap = getCapability("get_auth_alerts");
    expect(cap).toBeDefined();
    expect(pluginSettingsGetAuthAlerts.domain).toBe("plugin");
    expect(pluginSettingsGetAuthAlerts.mode).toBe("sync");
  });

  it("is read-only, deny-by-default, admin-gated, billing-gate-exempt", () => {
    expect(pluginSettingsGetAuthAlerts.scoped).toBe(true);
    expect(pluginSettingsGetAuthAlerts.noBillingGate).toBe(true);
    expect(pluginSettingsGetAuthAlerts.defaultEffect).toBe("deny");
    expect(pluginSettingsGetAuthAlerts.sensitivity).toBe("low");
    expect(pluginSettingsGetAuthAlerts.defaultRoles.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("declares the app layer (UI parity promise)", () => {
    expect(pluginSettingsGetAuthAlerts.layers).toEqual(
      expect.arrayContaining(["app", "api", "mcp", "docs", "unit"]),
    );
  });

  it("takes no input", () => {
    expect(pluginSettingsGetAuthAlerts.input.parse({})).toEqual({});
  });

  it("parses a valid output and rejects unknown roles", () => {
    const parsed = pluginSettingsGetAuthAlerts.output.parse({
      sendEmail: true,
      roles: ["Owner", "Compliance"],
      isDefault: false,
    });
    expect(parsed.roles).toEqual(["Owner", "Compliance"]);
    expect(() =>
      pluginSettingsGetAuthAlerts.output.parse({
        sendEmail: true,
        roles: ["Root"],
        isDefault: false,
      }),
    ).toThrow();
  });

  it("rejects an empty roles list", () => {
    expect(() =>
      pluginSettingsGetAuthAlerts.output.parse({
        sendEmail: false,
        roles: [],
        isDefault: false,
      }),
    ).toThrow();
  });
});
