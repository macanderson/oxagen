/**
 * plugin.settings.get_auth_alerts handler tests.
 *
 * Mocks withSystemDb; asserts the stored setting round-trips, the documented
 * default is returned when unset, and malformed stored values degrade to the
 * default rather than throwing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  settingsRows: [] as Record<string, unknown>[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

import { pluginSettingsGetAuthAlertsHandler } from "./plugin.settings.get_auth_alerts";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function makeTx() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mocks.settingsRows),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsRows = [];
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
});

describe("pluginSettingsGetAuthAlertsHandler", () => {
  it("returns the documented default when the org never set the value", async () => {
    mocks.settingsRows = [{ settings: {} }];
    const out = await pluginSettingsGetAuthAlertsHandler({}, CTX);
    expect(out).toEqual({
      sendEmail: true,
      roles: ["Owner", "Admin"],
      isDefault: true,
    });
  });

  it("returns the default when the org row is missing entirely", async () => {
    mocks.settingsRows = [];
    const out = await pluginSettingsGetAuthAlertsHandler({}, CTX);
    expect(out.isDefault).toBe(true);
  });

  it("returns the stored setting when customised", async () => {
    mocks.settingsRows = [
      {
        settings: {
          mcp_auth_alerts: {
            send_email: false,
            roles: ["Owner", "Compliance"],
          },
        },
      },
    ];
    const out = await pluginSettingsGetAuthAlertsHandler({}, CTX);
    expect(out).toEqual({
      sendEmail: false,
      roles: ["Owner", "Compliance"],
      isDefault: false,
    });
  });

  it("filters unknown roles and falls back to default when none survive", async () => {
    mocks.settingsRows = [
      {
        settings: {
          mcp_auth_alerts: { send_email: true, roles: ["Root", "Superuser"] },
        },
      },
    ];
    const out = await pluginSettingsGetAuthAlertsHandler({}, CTX);
    expect(out).toEqual({
      sendEmail: true,
      roles: ["Owner", "Admin"],
      isDefault: true,
    });
  });

  it("falls back to default on a malformed send_email", async () => {
    mocks.settingsRows = [
      {
        settings: {
          mcp_auth_alerts: { send_email: "yes", roles: ["Owner"] },
        },
      },
    ];
    const out = await pluginSettingsGetAuthAlertsHandler({}, CTX);
    expect(out.isDefault).toBe(true);
  });
});
