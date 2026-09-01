import { z } from "zod";
import {
  registerConnector,
  type AuthCredential,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RawRecord,
  type RecordTypeSample,
} from "../types";

const connectionConfigSchema = z.object({
  // Constrained to a bare DNS label: this value is interpolated into the API
  // host, so anything with a dot, slash or credential in it could point the
  // Authorization header at another origin.
  subdomain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  email: z.string().email().optional(),
  syncDepthDays: z.number().int().positive().default(90),
  pageSize: z.number().int().min(1).max(1000).default(1000),
});

type Config = typeof connectionConfigSchema;

// Zendesk's incremental export endpoints, which exist for exactly this job:
// give them a start_time and they page through everything changed since, in
// updated-at order, ending with end_of_stream.
const INCREMENTAL_PATH: Record<string, string> = {
  ticket: "/api/v2/incremental/tickets.json",
  user: "/api/v2/incremental/users.json",
  organization: "/api/v2/incremental/organizations.json",
  ticket_comment: "/api/v2/incremental/ticket_events.json",
};

/** The array key each incremental export wraps its records in. */
const COLLECTION_KEY: Record<string, string> = {
  ticket: "tickets",
  user: "users",
  organization: "organizations",
  ticket_comment: "ticket_events",
};

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/**
 * Zendesk speaks three credential shapes and all three reach here through the
 * AuthCredential seam: an OAuth access token as a bearer, a stored basic
 * credential verbatim, and an API token — which Zendesk authenticates as basic
 * auth with the literal suffix `/token` on the agent's email. The email is an
 * account identifier rather than a secret, so it lives in config beside the
 * subdomain and only the token itself is stored encrypted.
 */
function zendeskAuthHeader(
  auth: AuthCredential,
  email: string | undefined,
): string | null {
  if (auth.scheme === "bearer_token") return `Bearer ${auth.token}`;
  if (auth.scheme === "basic_auth")
    return basicHeader(auth.username, auth.password);
  if (auth.scheme === "api_key") {
    return email ? basicHeader(`${email}/token`, auth.apiKey) : null;
  }
  return null;
}

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

/** Zendesk ids are JSON numbers; externalId is a string everywhere in ingestion. */
function idOf(r: Record<string, unknown>): string | undefined {
  const v = r["id"];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function isoToEpoch(cursor: string): number | null {
  const t = new Date(cursor).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/**
 * Zendesk refuses a start_time inside the last minute, and its window is
 * inclusive (`updated_at >= start_time`), so the newest record of one poll comes
 * back again in the next. Downstream dedup absorbs that repeat; nudging the
 * cursor forward a second instead would silently drop every other record
 * sharing that same second.
 */
function startTimeFor(cursor: string | null, syncDepthDays: number): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromCursor = cursor !== null ? isoToEpoch(cursor) : null;
  const start = fromCursor ?? nowSec - syncDepthDays * 86_400;
  return Math.min(start, nowSec - 60);
}

/**
 * `next_page` is a full URL composed by Zendesk. Follow it only while it stays
 * on the tenant's own origin, so a surprising redirect target can never be
 * handed the Authorization header.
 */
function sameOriginNextPage(
  nextPage: string | undefined,
  baseOrigin: string,
): string | null {
  if (!nextPage) return null;
  try {
    return new URL(nextPage).origin === baseOrigin ? nextPage : null;
  } catch {
    return null;
  }
}

/**
 * Zendesk publishes no incremental export for comments on their own. The
 * ticket_events export is the supported path: one event per ticket update, with
 * the comment nested in child_events. Each Comment child is lifted out and
 * stamped with its parent's ticket id and timestamp — the fields cursorOf and
 * normalizeRecord go on to read.
 */
function* commentRecords(
  event: Record<string, unknown>,
  receivedAt: string,
): Generator<RawRecord> {
  const createdAt = asString(event["created_at"]);
  const ticketId = event["ticket_id"];
  for (const child of asArray(event["child_events"]).map(asRecord)) {
    if (child["event_type"] !== "Comment") continue;
    const id = idOf(child);
    if (!id) continue;
    yield {
      sourceRecordType: "ticket_comment",
      externalId: id,
      raw: { ...child, ticket_id: ticketId, created_at: createdAt },
      receivedAt,
    };
  }
}

/** Every Zendesk object carries its API url; the agent-facing page shares that host. */
function agentUrl(
  apiUrl: string | undefined,
  section: string,
  id: string,
): string | undefined {
  if (!apiUrl || !id) return undefined;
  try {
    return `${new URL(apiUrl).origin}/agent/${section}/${id}`;
  } catch {
    return undefined;
  }
}

const zendesk: ConnectorDefinition<Config> = {
  connectorId: "zendesk",
  displayName: "Zendesk",
  description:
    "Sync tickets, ticket comments, users, and organizations from Zendesk Support.",
  icon: "zendesk",
  supportedAuthSchemes: ["oauth2_authorization_code", "api_key", "basic_auth"],
  deliveryMethod: "rest_polling",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("zendesk.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);
    const id = idOf(r) ?? "";

    switch (sourceRecordType) {
      case "ticket": {
        const via = asRecord(r["via"]);
        const satisfaction = asRecord(r["satisfaction_rating"]);
        return {
          externalId: id,
          externalUrl: agentUrl(asString(r["url"]), "tickets", id),
          displayName: asString(r["subject"]),
          properties: {
            subject: asString(r["subject"]),
            description: asString(r["description"]),
            status: asString(r["status"]),
            priority: asString(r["priority"]),
            type: asString(r["type"]),
            tags: asArray(r["tags"]).filter((t) => typeof t === "string"),
            channel: asString(via["channel"]),
            requesterId: r["requester_id"],
            assigneeId: r["assignee_id"],
            organizationId: r["organization_id"],
            groupId: r["group_id"],
            satisfactionScore: asString(satisfaction["score"]),
            dueAt: asString(r["due_at"]),
            createdAt: asString(r["created_at"]),
            updatedAt: asString(r["updated_at"]),
          },
        };
      }

      case "ticket_comment": {
        const body = asString(r["body"]);
        return {
          externalId: id,
          displayName: body?.slice(0, 100),
          properties: {
            body,
            htmlBody: asString(r["html_body"]),
            public: r["public"],
            authorId: r["author_id"],
            ticketId: r["ticket_id"],
            createdAt: asString(r["created_at"]),
          },
        };
      }

      case "user": {
        return {
          externalId: id,
          externalUrl: agentUrl(asString(r["url"]), "users", id),
          displayName: asString(r["name"]) ?? asString(r["email"]),
          properties: {
            name: asString(r["name"]),
            email: asString(r["email"]),
            role: asString(r["role"]),
            phone: asString(r["phone"]),
            active: r["active"],
            verified: r["verified"],
            suspended: r["suspended"],
            organizationId: r["organization_id"],
            timeZone: asString(r["time_zone"]),
            lastLoginAt: asString(r["last_login_at"]),
            createdAt: asString(r["created_at"]),
            updatedAt: asString(r["updated_at"]),
          },
        };
      }

      case "organization": {
        return {
          externalId: id,
          externalUrl: agentUrl(asString(r["url"]), "organizations", id),
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            details: asString(r["details"]),
            notes: asString(r["notes"]),
            domainNames: asArray(r["domain_names"]).filter(
              (d) => typeof d === "string",
            ),
            tags: asArray(r["tags"]).filter((t) => typeof t === "string"),
            groupId: r["group_id"],
            sharedTickets: r["shared_tickets"],
            createdAt: asString(r["created_at"]),
            updatedAt: asString(r["updated_at"]),
          },
        };
      }

      default:
        throw new Error(
          `zendesk.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },

  /**
   * Incremental export poll. Seeds start_time from the durable cursor and then
   * follows Zendesk's own `next_page` links until it reports end_of_stream, so
   * the whole changed window is drained in one cycle rather than a fixed number
   * of pages. Zendesk paginates these exports in updated-at order and each
   * next_page carries the following window's start_time, which is what makes
   * the cursor advance correctly across a page boundary.
   */
  async *poll(auth, config, recordType, cursor): AsyncIterable<RawRecord> {
    const authHeader = zendeskAuthHeader(auth, config.email);
    if (!authHeader) return;

    const path = INCREMENTAL_PATH[recordType];
    const collectionKey = COLLECTION_KEY[recordType];
    if (!path || !collectionKey) return; // not a pollable record type

    const baseOrigin = `https://${config.subdomain}.zendesk.com`;
    const first = new URL(path, baseOrigin);
    first.searchParams.set(
      "start_time",
      String(startTimeFor(cursor, config.syncDepthDays)),
    );
    first.searchParams.set("per_page", String(config.pageSize));
    // Comment bodies ride in child_events only when explicitly requested.
    if (recordType === "ticket_comment")
      first.searchParams.set("include", "comment_events");

    const receivedAt = new Date().toISOString();
    let next: string | null = first.toString();

    while (next !== null) {
      const resp = await fetch(next, {
        headers: { Authorization: authHeader, Accept: "application/json" },
      });
      if (!resp.ok) {
        // Zendesk caps the incremental endpoints at 10 requests a minute and
        // answers 429 past that; like a bad token's 401 it surfaces as a poll
        // failure, which is what degrades the connection's health.
        throw new Error(
          `zendesk.poll: incremental export ${resp.status} for ${recordType}`,
        );
      }
      const json = (await resp.json()) as Record<string, unknown>;

      for (const item of asArray(json[collectionKey]).map(asRecord)) {
        if (recordType === "ticket_comment") {
          yield* commentRecords(item, receivedAt);
          continue;
        }
        const itemId = idOf(item);
        if (!itemId) continue;
        yield {
          sourceRecordType: recordType,
          externalId: itemId,
          raw: item,
          receivedAt,
        };
      }

      next =
        json["end_of_stream"] === true
          ? null
          : sameOriginNextPage(asString(json["next_page"]), baseOrigin);
    }
  },

  // Cursor watermark: Zendesk's updated_at. Comments are lifted out of a
  // ticket_events page and carry their parent event's created_at instead.
  cursorOf(_recordType, raw): string | null {
    const r = asRecord(raw);
    return asString(r["updated_at"]) ?? asString(r["created_at"]) ?? null;
  },
};

registerConnector(zendesk);

export { zendesk };
