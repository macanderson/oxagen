import type { schema } from "@oxagen/database";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { connectionMappingsGet } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { describe, expect, it } from "vitest";
import { Source } from "@/data/contracts";
import {
  type ConnectionRow,
  formatCursor,
  isOntologySource,
  type MappingRow,
  SOURCE_KINDS,
  toEntities,
  toSource,
  toSyncHealth,
} from "./ontology";

type SourceConnectionRow = typeof schema.sourceConnections.$inferSelect;

// A representative ingestion.source_connections row, column for column as
// Drizzle selects it: a GitHub connection that has synced twice and advanced
// two record-type watermarks.
const TABLE_ROW: SourceConnectionRow = {
  id: "0192d4a8-7c1e-7a00-8000-0000000c0001",
  publicId: "con_01K5RSGH7Q",
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
  updatedAt: new Date("2026-09-11T07:31:00.000Z"),
  workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  connectorId: "github",
  displayName: "GitHub · acme/platform",
  authScheme: "github_app",
  deliveryMethod: "webhook",
  deliveryConfig: { installationId: "5512" },
  status: "connected",
  entityCount: 184022,
  cursor: {
    pull_request: "2026-09-11T07:31:00Z",
    issue: "2026-09-11T07:29:00Z",
  },
  lastSyncAt: new Date("2026-09-11T07:31:04.120Z"),
  errorMessage: null,
  healthStatus: "healthy",
  consecutiveFailureCount: 0,
  lastPollAt: new Date("2026-09-11T07:31:00.000Z"),
  nextPollAt: new Date("2026-09-11T07:36:00.000Z"),
  lastErrorAt: null,
  deletedAt: null,
  deletedByUserId: null,
  oauthAccountId: null,
  createdByUserId: "0192d4a8-7c1e-7a00-8000-0000000000ab",
  updatedByUserId: null,
};

// What the list_connections handler returns for that row, parsed by the
// capability's own output schema so the fixture cannot drift from the contract.
function listed(row: SourceConnectionRow): ConnectionRow {
  const [connection] = connectionList.output.parse({
    connections: [
      {
        id: row.id,
        publicId: row.publicId,
        connectorId: row.connectorId,
        displayName: row.displayName,
        authScheme: row.authScheme,
        deliveryMethod: row.deliveryMethod,
        status: row.status,
        entityCount: row.entityCount,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        healthStatus: row.healthStatus,
        lastPollAt: row.lastPollAt?.toISOString() ?? null,
        nextPollAt: row.nextPollAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      },
    ],
  }).connections;
  if (!connection) throw new Error("fixture row did not parse");
  return connection;
}

const MAPPINGS: MappingRow[] = connectionMappingsGet.output.parse({
  mappings: [
    {
      id: "etm-1",
      sourceRecordType: "pull_request",
      oxagenEntityType: "PullRequest",
      propertyMappings: { title: "title" },
      isActive: true,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
    {
      id: "etm-2",
      sourceRecordType: "issue",
      oxagenEntityType: "Issue",
      propertyMappings: {},
      isActive: true,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
    {
      id: "etm-3",
      sourceRecordType: "repository",
      oxagenEntityType: "Repository",
      propertyMappings: {},
      isActive: false,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
    {
      id: "etm-4",
      sourceRecordType: "pull_request_review",
      oxagenEntityType: "PullRequest",
      propertyMappings: {},
      isActive: true,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
  ],
}).mappings;

describe("toSource: a real source_connections row through the Source view model", () => {
  it("maps every column and parses through Source", () => {
    const mapped = toSource({
      connection: listed(TABLE_ROW),
      mappings: MAPPINGS,
      cursor: TABLE_ROW.cursor,
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(Source.parse(mapped.source)).toEqual({
      name: "GitHub · acme/platform",
      kind: "github",
      records: 184022,
      lastSyncAt: "2026-09-11T07:31:04.120Z",
      health: "ok",
      cursor: "issue 2026-09-11T07:29:00Z · pull_request 2026-09-11T07:31:00Z",
      entities: ["Issue", "PullRequest"],
    });
  });

  it("refuses to invent a sync time for a source that never synced (negative)", () => {
    const connection = listed({ ...TABLE_ROW, lastSyncAt: null });
    expect(toSource({ connection, mappings: MAPPINGS, cursor: null })).toEqual({
      ok: false,
      unrecorded: "lastSyncAt",
    });
  });

  it.each(["slack", "toString", "__proto__", "constructor"])(
    "refuses connector %s, which has no spec source kind (negative)",
    (connectorId) => {
      const connection = listed({ ...TABLE_ROW, connectorId });
      expect(toSource({ connection, mappings: [], cursor: null })).toEqual({
        ok: false,
        unrecorded: "kind",
      });
    },
  );

  it("keeps a real zero: a synced source that landed nothing has records 0", () => {
    const mapped = toSource({
      connection: listed({ ...TABLE_ROW, entityCount: 0 }),
      mappings: [],
      cursor: null,
    });
    expect(mapped).toMatchObject({
      ok: true,
      source: { records: 0, cursor: "", entities: [] },
    });
  });
});

describe("isOntologySource", () => {
  it.each(["connected", "paused", "error"])(
    "lists a %s GitHub or Linear connection",
    (status) => {
      expect(isOntologySource(listed({ ...TABLE_ROW, status }))).toBe(true);
      expect(
        isOntologySource(
          listed({ ...TABLE_ROW, status, connectorId: "linear" }),
        ),
      ).toBe(true);
    },
  );

  it.each(["pending_setup", "deleting", "deleted"])(
    "does not list a %s connection (negative)",
    (status) => {
      expect(isOntologySource(listed({ ...TABLE_ROW, status }))).toBe(false);
    },
  );

  it.each(["slack", "google-drive", "custom-sql", "toString", "__proto__"])(
    "does not list connector %s, which has no spec source kind (negative)",
    (connectorId) => {
      expect(isOntologySource(listed({ ...TABLE_ROW, connectorId }))).toBe(
        false,
      );
    },
  );

  it("maps no connector to postgres until a Postgres connector exists", () => {
    expect(Object.values(SOURCE_KINDS)).not.toContain("postgres");
  });
});

describe("toSyncHealth", () => {
  it("maps the poll roll-up onto the spec's health words", () => {
    expect(toSyncHealth("connected", "healthy")).toBe("ok");
    expect(toSyncHealth("connected", "degraded")).toBe("degraded");
    expect(toSyncHealth("paused", "errored")).toBe("failed");
  });

  it("never reports a connection in error status as ok (negative)", () => {
    expect(toSyncHealth("error", "healthy")).toBe("failed");
    expect(toSyncHealth("error", "degraded")).toBe("failed");
  });
});

describe("formatCursor", () => {
  it("renders each record type's watermark, record types sorted", () => {
    expect(formatCursor({ b: "2", a: "1" })).toBe("a 1 · b 2");
  });

  it("renders a non-string watermark as JSON rather than dropping it", () => {
    expect(formatCursor({ page: 12, since: { id: 4 } })).toBe(
      'page 12 · since {"id":4}',
    );
  });

  it("skips record types with no watermark", () => {
    expect(formatCursor({ a: null, b: "x" })).toBe("b x");
  });

  it.each([null, undefined, "cursor", 7, ["a"], {}])(
    "is empty when no cursor has advanced: %j",
    (cursor) => {
      expect(formatCursor(cursor)).toBe("");
    },
  );
});

describe("toEntities", () => {
  it("lists active mappings' entity types once, sorted", () => {
    expect(toEntities(MAPPINGS)).toEqual(["Issue", "PullRequest"]);
  });

  it("drops inactive mappings (negative)", () => {
    expect(
      toEntities(MAPPINGS.filter((m) => m.oxagenEntityType === "Repository")),
    ).toEqual([]);
  });
});
