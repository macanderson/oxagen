import { describe, it, expect } from "vitest";
import { pluginSettingsSetAuthAlerts } from "./plugin.settings.set_auth_alerts";

describe("plugin.settings.set_auth_alerts contract", () => {
  it("has correct name and domain", () => {
    expect(pluginSettingsSetAuthAlerts.name).toBe("set_auth_alerts");
    expect(pluginSettingsSetAuthAlerts.domain).toBe("plugin");
  });

  it("parses valid input", () => {
    const parsed = pluginSettingsSetAuthAlerts.input.parse({
      sendEmail: true,
      roles: ["Owner", "Admin"],
    });
    expect(parsed.sendEmail).toBe(true);
    expect(parsed.roles).toEqual(["Owner", "Admin"]);
  });

  it("rejects empty roles array", () => {
    expect(() =>
      pluginSettingsSetAuthAlerts.input.parse({ sendEmail: false, roles: [] }),
    ).toThrow();
  });

  it("rejects invalid role names", () => {
    expect(() =>
      pluginSettingsSetAuthAlerts.input.parse({
        sendEmail: true,
        roles: ["Member"],
      }),
    ).toThrow();
  });
});
