import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { microsoft } from "./microsoft/index";
import { googleDrive } from "./google/drive";
import { googleGmail } from "./google/gmail";
import { googleCalendar } from "./google/calendar";
import type { AuthCredential } from "./types";

// subscribeWebhooks() unit tests — mock global fetch and assert each connector
// calls the correct provider subscription endpoint, threads the webhook URL, and
// returns the { subscriptionId, secret, expiresAt } shape the provisioner
// persists. No network, no DB.

const auth: AuthCredential = { scheme: "bearer_token", token: "tok-123" };
const webhookUrl = "https://api.oxagen.sh/webhooks/microsoft/con_abc";

let fetchMock: ReturnType<typeof vi.fn>;

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("microsoft.subscribeWebhooks", () => {
  it("POSTs a Graph subscription per configured service and returns the shape", async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ id: "sub-outlook" }))
      .mockResolvedValueOnce(okJson({ id: "sub-calendar" }));

    const result = await microsoft.subscribeWebhooks!(
      auth,
      { tenantId: "t1", services: ["outlook", "calendar"], syncDepthDays: 90 },
      webhookUrl,
    );

    // Two subscriptions (outlook + calendar), both to Graph /subscriptions.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.notificationUrl).toBe(webhookUrl);
    expect(typeof body.clientState).toBe("string");
    expect(body.clientState.length).toBeGreaterThan(20);
    expect(body.expirationDateTime).toBeTruthy();

    // clientState is the returned secret; both subscription ids are joined.
    expect(result.subscriptionId).toBe("sub-outlook,sub-calendar");
    expect(result.secret).toBe(body.clientState);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.recordTypes).toEqual(["outlook_message", "calendar_event"]);
  });

  it("throws when the connection has no bearer token", async () => {
    await expect(
      microsoft.subscribeWebhooks!(
        { scheme: "public" } as AuthCredential,
        { tenantId: "t1", services: ["outlook"], syncDepthDays: 90 },
        webhookUrl,
      ),
    ).rejects.toThrow(/no usable bearer token/);
  });

  it("throws when Graph returns a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });
    await expect(
      microsoft.subscribeWebhooks!(
        auth,
        { tenantId: "t1", services: ["outlook"], syncDepthDays: 90 },
        webhookUrl,
      ),
    ).rejects.toThrow(/Graph POST \/subscriptions failed \(403\)/);
  });

  it("throws when no webhook-capable service is configured", async () => {
    await expect(
      microsoft.subscribeWebhooks!(
        auth,
        // teams + sharepoint have no modeled webhook resource → empty set.
        {
          tenantId: "t1",
          services: ["teams", "sharepoint"],
          syncDepthDays: 90,
        },
        webhookUrl,
      ),
    ).rejects.toThrow(/no webhook-capable services/);
  });
});

describe("google connectors subscribeWebhooks (watch channels)", () => {
  it("google-drive watches the changes feed with a channel token", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        id: "chan-1",
        resourceId: "res-1",
        expiration: "1893456000000",
      }),
    );
    const result = await googleDrive.subscribeWebhooks!(
      auth,
      { sharedDrivesOnly: false },
      "https://api.oxagen.sh/webhooks/google-drive/con_d",
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/drive/v3/changes/watch");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.type).toBe("web_hook");
    expect(body.address).toBe(
      "https://api.oxagen.sh/webhooks/google-drive/con_d",
    );
    expect(typeof body.token).toBe("string");
    // resourceId is persisted as the provider subscription id; token is the secret.
    expect(result.subscriptionId).toBe("res-1");
    expect(result.secret).toBe(body.token);
    // expiration echoed back wins over the requested ttl.
    expect(result.expiresAt).toEqual(new Date(1893456000000));
    expect(result.hmacHeader).toBe("x-goog-channel-token");
  });

  it("google-gmail calls users.watch and scopes labelIds", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ resourceId: "res-g" }));
    await googleGmail.subscribeWebhooks!(
      auth,
      { labelIds: ["INBOX"], includeSpamTrash: false, syncDaysBack: 30 },
      "https://api.oxagen.sh/webhooks/google-gmail/con_g",
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/watch");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.labelIds).toEqual(["INBOX"]);
  });

  it("google-calendar watches the primary events feed", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ resourceId: "res-c" }));
    await googleCalendar.subscribeWebhooks!(
      auth,
      { includeDeclinedEvents: false, syncMonthsBack: 3 },
      "https://api.oxagen.sh/webhooks/google-calendar/con_c",
    );
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
    );
  });

  it("throws on a non-2xx watch response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    await expect(
      googleDrive.subscribeWebhooks!(
        auth,
        { sharedDrivesOnly: false },
        "https://api.oxagen.sh/webhooks/google-drive/con_d",
      ),
    ).rejects.toThrow(/failed \(401\)/);
  });
});
