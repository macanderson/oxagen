/**
 * Unit tests for GET /v1/:org/:ws/plugin/settings/auth-alerts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { pluginSettingsGetAuthAlertsRoute } from "./plugin.settings.get_auth_alerts";

const fakeCtx = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { sendEmail: true, roles: ["Owner", "Admin"], isDefault: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

describe("GET plugin/settings/auth-alerts", () => {
  it("invokes get_auth_alerts with surface api and returns the setting", async () => {
    const res = await pluginSettingsGetAuthAlertsRoute.fetch(
      new Request("http://localhost/"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith("get_auth_alerts", {}, fakeCtx, {
      surface: "api",
    });
  });
});
