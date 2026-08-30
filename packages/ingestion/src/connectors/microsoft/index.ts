import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  registerConnector,
  type AuthCredential,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
  type WebhookSubscriptionResult,
} from "../types";
import { constantTimeStringEqual } from "../safe-compare";

const connectionConfigSchema = z.object({
  tenantId: z.string(),
  services: z
    .array(z.enum(["outlook", "teams", "sharepoint", "onedrive", "calendar"]))
    .default(["outlook", "teams"]),
  syncDepthDays: z.number().int().positive().default(90),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Resolve a usable bearer token from the resolved connection credential. */
function bearerToken(auth: AuthCredential): string | null {
  if (auth.scheme === "bearer_token") return auth.token;
  return null;
}

/**
 * Map configured Microsoft 365 services to Graph change-notification resource
 * paths + the source record type each delivers. Services without a webhook
 * resource (teams — requires a per-team/channel resource we do not yet model)
 * are skipped; they fall back to polling.
 */
function graphResourcesFor(
  services: readonly string[],
): Array<{ resource: string; recordType: string }> {
  const out: Array<{ resource: string; recordType: string }> = [];
  for (const service of services) {
    switch (service) {
      case "outlook":
        out.push({
          resource: "/users/messages",
          recordType: "outlook_message",
        });
        break;
      case "calendar":
        out.push({ resource: "/users/events", recordType: "calendar_event" });
        break;
      case "onedrive":
        out.push({ resource: "/drive/root", recordType: "onedrive_file" });
        break;
      // sharepoint + teams need per-site/per-channel resource paths that this
      // connector config does not carry yet — poll-only for now.
      default:
        break;
    }
  }
  return out;
}

const microsoft: ConnectorDefinition<Config> = {
  connectorId: "microsoft",
  displayName: "Microsoft 365",
  description:
    "Sync emails, Teams messages, SharePoint files, OneDrive documents, and calendar events from Microsoft 365.",
  icon: "microsoft",
  // Application permissions + admin consent, not delegated
  supportedAuthSchemes: ["oauth2_client_credentials"],
  deliveryMethod: "webhook",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("microsoft.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "outlook_message":
      case "email": {
        const from = asRecord(asRecord(r["from"])["emailAddress"]);
        const toRecipients = asArray(r["toRecipients"])
          .map((t) =>
            asString(asRecord(asRecord(t)["emailAddress"])["address"]),
          )
          .filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["subject"]),
          properties: {
            subject: asString(r["subject"]),
            fromName: asString(from["name"]),
            fromEmail: asString(from["address"]),
            toRecipients,
            bodyPreview: asString(r["bodyPreview"]),
            importance: asString(r["importance"]),
            isRead: r["isRead"],
            hasAttachments: r["hasAttachments"],
            sentDateTime: asString(r["sentDateTime"]),
            receivedDateTime: asString(r["receivedDateTime"]),
            webLink: asString(r["webLink"]),
          },
        };
      }

      case "teams_message": {
        const fromUser = asRecord(asRecord(r["from"])["user"]);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName:
            asString(r["summary"]) ??
            asString(asRecord(r["body"])["content"])?.slice(0, 100),
          properties: {
            body: asString(asRecord(r["body"])["content"]),
            fromUserId: asString(fromUser["id"]),
            fromUserName: asString(fromUser["displayName"]),
            channelId: asString(r["channelIdentity"]),
            messageType: asString(r["messageType"]),
            importance: asString(r["importance"]),
            replyToId: asString(r["replyToId"]),
            createdDateTime: asString(r["createdDateTime"]),
            lastModifiedDateTime: asString(r["lastModifiedDateTime"]),
            webUrl: asString(r["webUrl"]),
          },
        };
      }

      case "sharepoint_file":
      case "onedrive_file": {
        const createdBy = asRecord(asRecord(r["createdBy"])["user"]);
        const lastModifiedBy = asRecord(asRecord(r["lastModifiedBy"])["user"]);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["webUrl"]),
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            size: r["size"],
            mimeType: asString(asRecord(r["file"])["mimeType"]),
            createdBy: asString(createdBy["displayName"]),
            lastModifiedBy: asString(lastModifiedBy["displayName"]),
            createdDateTime: asString(r["createdDateTime"]),
            lastModifiedDateTime: asString(r["lastModifiedDateTime"]),
            webUrl: asString(r["webUrl"]),
            downloadUrl: asString(r["@microsoft.graph.downloadUrl"]),
          },
        };
      }

      case "calendar_event": {
        const organizer = asRecord(asRecord(r["organizer"])["emailAddress"]);
        const attendees = asArray(r["attendees"])
          .map((a) =>
            asString(asRecord(asRecord(a)["emailAddress"])["address"]),
          )
          .filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["webLink"]),
          displayName: asString(r["subject"]),
          properties: {
            subject: asString(r["subject"]),
            organizer: asString(organizer["address"]),
            attendees,
            start: asString(asRecord(r["start"])["dateTime"]),
            end: asString(asRecord(r["end"])["dateTime"]),
            location: asString(asRecord(r["location"])["displayName"]),
            isOnlineMeeting: r["isOnlineMeeting"],
            onlineMeetingUrl: asString(r["onlineMeetingUrl"]),
            bodyPreview: asString(r["bodyPreview"]),
            webLink: asString(r["webLink"]),
          },
        };
      }

      default:
        throw new Error(
          `microsoft.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },

  // Register a Microsoft Graph change-notification subscription per configured
  // service, verified back on delivery via `clientState` (the returned secret).
  // Graph caps subscription lifetime per resource; we request ~2.9 days (the
  // common max for mail/events/drive) and let the renewal cron re-subscribe.
  async subscribeWebhooks(
    auth,
    config,
    webhookUrl,
  ): Promise<WebhookSubscriptionResult> {
    const token = bearerToken(auth);
    if (!token) {
      throw new Error(
        "microsoft.subscribeWebhooks: connection has no usable bearer token",
      );
    }

    // clientState doubles as the shared secret verifyWebhook checks. 32 random
    // bytes, base64url — well under Graph's 128-char clientState limit.
    const clientState = randomBytes(32).toString("base64url");
    // Graph max is 4230 min for most resources; stay a hair under.
    const expiresAt = new Date(Date.now() + 4200 * 60 * 1000);
    const resources = graphResourcesFor(config.services);
    if (resources.length === 0) {
      throw new Error(
        "microsoft.subscribeWebhooks: no webhook-capable services configured",
      );
    }

    // One subscription per resource; return the first id (renewal re-subscribes
    // all of them). Graph requires a separate subscription per resource path.
    const created: string[] = [];
    const recordTypes: string[] = [];
    for (const { resource, recordType } of resources) {
      const resp = await fetch(
        "https://graph.microsoft.com/v1.0/subscriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            changeType: "created,updated",
            notificationUrl: webhookUrl,
            resource,
            expirationDateTime: expiresAt.toISOString(),
            clientState,
          }),
        },
      );
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(
          `microsoft.subscribeWebhooks: Graph POST /subscriptions failed (${resp.status}) for ${resource}: ${detail.slice(0, 200)}`,
        );
      }
      const body = (await resp.json()) as { id?: unknown };
      if (typeof body.id === "string") created.push(body.id);
      recordTypes.push(recordType);
    }

    return {
      subscriptionId: created.join(","),
      secret: clientState,
      expiresAt,
      recordTypes,
      hmacHeader: undefined,
      hmacAlgorithm: "clientState",
    };
  },

  verifyWebhook(payload, _headers, secret): boolean {
    // MS Graph lifecycle notifications carry a `clientState` field in the JSON
    // body. We set clientState = the webhook secret at subscription time, so we
    // verify by parsing the notification body and confirming every notification
    // entry's clientState matches the stored secret.
    //
    // The `validationToken` handshake (one-time subscription lifecycle) is
    // handled at the route layer before verifyWebhook is called — it never
    // reaches here.
    if (secret == null) return false;

    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(payload).toString("utf8"));
    } catch {
      return false;
    }

    if (
      body === null ||
      typeof body !== "object" ||
      !Array.isArray((body as Record<string, unknown>)["value"])
    ) {
      return false;
    }

    const notifications = (body as Record<string, unknown>)[
      "value"
    ] as unknown[];
    if (notifications.length === 0) return false;

    // Constant-time compare — a plain `===` here leaks the secret via
    // response-time analysis on this unauthenticated route.
    return notifications.every((n) => {
      if (n === null || typeof n !== "object") return false;
      const clientState = (n as Record<string, unknown>)["clientState"];
      return (
        typeof clientState === "string" &&
        constantTimeStringEqual(clientState, secret)
      );
    });
  },
};

registerConnector(microsoft);

export { microsoft };
