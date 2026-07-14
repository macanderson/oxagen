import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Form-to-DB verification for the webhook provisioner: given an active webhook
// connection + a connector that returns a subscription, assert the row written
// to ingestion.webhook_subscriptions carries the ENCRYPTED secret envelope, the
// provider subscription id, the record types, and the expiry — the exact shape
// the delivery route (apps/api webhook.ts) and the renewal cron read back.

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  resolveConnectionAuth: vi.fn(),
  encrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  getConnector: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("@oxagen/crypto", () => ({
  encrypt: mocks.encrypt,
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
}));

vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: mocks.getConnector,
}));

vi.mock("./resolve-connection-auth", () => ({
  resolveConnectionAuth: mocks.resolveConnectionAuth,
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { provisionWebhookSubscription } from "./provision-webhook";

// Compile a captured drizzle sql`` object into its final { sql, params } using
// the real Postgres dialect — robust to drizzle internals and exactly what the
// driver would send.
const dialect = new PgDialect();
function compile(query: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(query as SQL);
  return { sql, params };
}

// A single mock tx.execute that records every SQL call and returns queued rows.
function makeDb(queue: unknown[][]) {
  const calls: unknown[] = [];
  let i = 0;
  const execute = vi.fn((query: unknown) => {
    calls.push(query);
    return Promise.resolve(queue[i++] ?? []);
  });
  const tx = { execute };
  mocks.withSystemDb.mockImplementation((cb: (t: typeof tx) => unknown) =>
    cb(tx),
  );
  return { calls, execute };
}

const connectorStub = {
  deliveryMethod: "webhook" as const,
  connectionConfigSchema: {
    safeParse: (v: unknown) => ({ success: true, data: v }),
  },
  subscribeWebhooks: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "ingestion:env:v1",
  });
  mocks.encrypt.mockResolvedValue(Buffer.from("ciphertext-bytes"));
  mocks.getConnector.mockReturnValue(connectorStub);
  mocks.resolveConnectionAuth.mockResolvedValue({
    auth: { scheme: "bearer_token", token: "tok" },
    deliveryConfig: {},
  });
  connectorStub.subscribeWebhooks.mockResolvedValue({
    subscriptionId: "graph-sub-1",
    secret: "the-shared-secret",
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    recordTypes: ["outlook_message"],
    hmacAlgorithm: "clientState",
  });
});

describe("provisionWebhookSubscription — form to DB", () => {
  it("writes an encrypted secret envelope + provider id + expiry to the row", async () => {
    const { execute } = makeDb([
      // 1: load connection
      [
        {
          id: "conn-uuid",
          public_id: "con_pub",
          connector_id: "microsoft",
          delivery_config: { tenantId: "t", services: ["outlook"] },
          status: "connected",
        },
      ],
      // 2: upsert returning
      [{ id: "whs-uuid", expires_at: "2026-08-01T00:00:00.000Z" }],
    ]);

    const result = await provisionWebhookSubscription("conn-uuid", "org-uuid");

    expect(result.outcome).toBe("subscribed");
    expect(result.providerSubscriptionId).toBe("graph-sub-1");
    expect(result.webhookSubscriptionId).toBe("whs-uuid");

    // The connector got the fully-qualified webhook URL for this connection.
    const [, , url] = connectorStub.subscribeWebhooks.mock.calls[0]!;
    expect(url).toMatch(/\/webhooks\/microsoft\/con_pub$/);

    // The secret was encrypted (never stored plaintext).
    expect(mocks.encrypt).toHaveBeenCalledWith(
      "the-shared-secret",
      "ingestion:env:v1",
      expect.anything(),
    );

    // Two DB round-trips: the load SELECT and the upsert INSERT.
    expect(execute).toHaveBeenCalledTimes(2);
    // The upsert params carry the base64 ciphertext envelope, provider id, expiry.
    const flat = JSON.stringify(compile(execute.mock.calls[1]![0]).params);
    expect(flat).toContain("graph-sub-1");
    expect(flat).toContain("2026-08-01T00:00:00.000Z");
    // secret_enc is a JSON string of { keyId, ciphertext } — plaintext absent.
    expect(flat).toContain("ingestion:env:v1");
    expect(flat).not.toContain("the-shared-secret");
    expect(flat).toContain(Buffer.from("ciphertext-bytes").toString("base64"));
  });

  it("skips a non-webhook connector without writing", async () => {
    mocks.getConnector.mockReturnValue({
      deliveryMethod: "rest_polling",
      connectionConfigSchema: {
        safeParse: () => ({ success: true, data: {} }),
      },
    });
    const { execute } = makeDb([
      [
        {
          id: "c",
          public_id: "p",
          connector_id: "linear",
          delivery_config: {},
          status: "connected",
        },
      ],
    ]);
    const result = await provisionWebhookSubscription("c", "o");
    expect(result.outcome).toBe("unsupported");
    // Only the load SELECT ran; no upsert.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips when the connection has no usable credential", async () => {
    mocks.resolveConnectionAuth.mockResolvedValue(null);
    makeDb([
      [
        {
          id: "c",
          public_id: "p",
          connector_id: "microsoft",
          delivery_config: {},
          status: "connected",
        },
      ],
    ]);
    const result = await provisionWebhookSubscription("c", "o");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("no_usable_credential");
    expect(connectorStub.subscribeWebhooks).not.toHaveBeenCalled();
  });

  it("skips a missing connection", async () => {
    makeDb([[]]);
    const result = await provisionWebhookSubscription("missing", "o");
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("connection_not_found");
  });
});
