import type { schema } from "@oxagen/database";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KillSwitch } from "@/data/contracts";
import {
  canonicalJson,
  descriptorDigest,
  serverIdOf,
  serverPublicIdOf,
  settle,
  toDeclaredToolVersion,
  toImportedToolVersions,
  toKillSwitch,
  toMcpCredentialConnection,
  toSourceConnection,
  toToolServer,
} from "./tools";

// Representative rows, typed from the drizzle `$inferSelect` shapes, so a column
// rename in packages/database breaks these tests before it breaks a page.
const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const T0 = new Date("2026-09-10T08:00:00.000Z");
const T1 = new Date("2026-09-11T09:14:02.000Z");

const audit = {
  createdAt: T0,
  updatedAt: T1,
  createdByUserId: null,
  updatedByUserId: null,
};

const mcpServerRow: typeof schema.mcpServers.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000005e1",
  publicId: "mcs_01k5rsgithub0000000000",
  ...audit,
  deletedAt: null,
  deletedByUserId: null,
  orgId: ORG,
  workspaceId: WS,
  orgListingId: "0192d4a8-7c1e-7a00-8000-00000000715d",
  name: "GitHub",
  transportType: "streamable-http",
  endpointUrl: "https://api.githubcopilot.com/mcp/",
  authStrategy: "bearer",
  authConfig: {},
  healthStatus: "healthy",
  lastHealthcheckAt: T1,
  discoveredTools: [{ name: "create_pull_request" }, { name: "list_issues" }],
  enabled: true,
};

const toolRow: typeof schema.tools.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-00000000701a",
  publicId: "tol_01k5rsdeploy00000000000",
  ...audit,
  orgId: ORG,
  workspaceId: WS,
  deletedAt: null,
  deletedByUserId: null,
  name: "Deploy preview",
  slug: "deploy_preview",
  description: null,
  source: "custom",
  enabled: true,
  activeVersionId: "0192d4a8-7c1e-7a00-8000-00000000701b",
  activatedByUserId: null,
  activatedAt: T0,
};

const toolVersionRow: typeof schema.toolVersions.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-00000000701b",
  publicId: "tlv_01k5rsdeploy00000000001",
  ...audit,
  orgId: ORG,
  workspaceId: WS,
  versionNumber: 2,
  isLatest: true,
  parentVersionId: null,
  publishedAt: T0,
  toolId: toolRow.id,
  inputSchema: { type: "object" },
  readOnly: false,
  riskGrade: "high",
  policyGroup: null,
  manifest: { name: "deploy_preview" },
  checksum: "a".repeat(64),
};

const snapshotRow: typeof schema.mcpToolSnapshots.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000005a9",
  publicId: "mtsnap_01k5rssnap0000000000",
  ...audit,
  orgId: ORG,
  workspaceId: WS,
  mcpServerId: mcpServerRow.id,
  toolName: "create_pull_request",
  schemaJson: {
    name: "create_pull_request",
    description: "Open a pull request",
    inputSchema: { type: "object", required: ["title"] },
  },
  capturedAt: T0,
};

const sourceConnectionRow: typeof schema.sourceConnections.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000c0",
  publicId: "con_01k5rslinear0000000000",
  createdAt: T0,
  updatedAt: T1,
  workspaceId: WS,
  orgId: ORG,
  connectorId: "linear",
  displayName: "Linear",
  authScheme: "oauth2_authorization_code",
  deliveryMethod: "poll",
  deliveryConfig: null,
  status: "connected",
  entityCount: 412,
  cursor: null,
  lastSyncAt: T1,
  errorMessage: null,
  healthStatus: "healthy",
  consecutiveFailureCount: 0,
  lastPollAt: T1,
  nextPollAt: null,
  lastErrorAt: null,
  deletedAt: null,
  deletedByUserId: null,
  oauthAccountId: null,
  createdByUserId: "0192d4a8-7c1e-7a00-8000-0000000a11ce",
  updatedByUserId: null,
};

const credentialRow: typeof schema.mcpCredentials.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000c4ed0",
  publicId: "mcrd_01k5rsgithubcred00000",
  ...audit,
  orgId: ORG,
  workspaceId: WS,
  orgListingId: mcpServerRow.orgListingId ?? "",
  authKind: "oauth",
  accessTokenEnc: null,
  refreshTokenEnc: null,
  secretEnc: null,
  oauthClientSecretEnc: null,
  tokenKmsKeyId: null,
  oauthClientId: null,
  scopes: ["repo"],
  expiresAt: null,
  status: "needs_reauth",
  lastRefreshedAt: null,
};

const emergencyDenyRow: typeof schema.emergencyDenies.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-00000000e3d0",
  publicId: "emd_01k5rsdeny00000000000",
  ...audit,
  orgId: ORG,
  workspaceId: null,
  scopeKind: "org",
  denyKind: "capability",
  capabilityId: "dispatch_tacho_command",
  resourceScopeDigest: null,
  principalId: null,
  reason: "credential probe from an unenrolled host",
  active: true,
  activatedAt: T1,
  deactivatedAt: null,
};

describe("server ids", () => {
  it("encode a public id as a URL segment and decode it back", () => {
    const id = serverIdOf(mcpServerRow.publicId);
    expect(id).toBe("mcs-01k5rsgithub0000000000");
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(serverPublicIdOf(id)).toBe(mcpServerRow.publicId);
  });
});

describe("toToolServer", () => {
  const src = {
    server: mcpServerRow,
    snapshots: { descriptorCount: 3, lastCapturedAt: T1 },
    credentialPublicId: credentialRow.publicId,
  };

  it("maps each recorded column and leaves the pending-schema count unrecorded", () => {
    expect(toToolServer(src)).toEqual({
      id: "mcs-01k5rsgithub0000000000",
      name: "GitHub",
      kind: "mcp",
      transport: "streamable_http",
      endpoint: "https://api.githubcopilot.com/mcp/",
      toolCount: 2,
      versionCount: 3,
      status: "active",
      health: "ok",
      lastImportAt: "2026-09-11T09:14:02.000Z",
      connectionId: "mcrd_01k5rsgithubcred00000",
      pendingSchemaCount: null,
    });
  });

  it("reads a disabled server as disabled, never killed", () => {
    expect(
      toToolServer({ ...src, server: { ...mcpServerRow, enabled: false } })
        .status,
    ).toBe("disabled");
  });

  it.each([
    ["degraded", "degraded"],
    ["unreachable", "degraded"],
    ["unknown", null],
  ])("health %s → %s (never stronger than recorded)", (recorded, shown) => {
    expect(
      toToolServer({
        ...src,
        server: { ...mcpServerRow, healthStatus: recorded },
      }).health,
    ).toBe(shown);
  });

  it("has no word for the sse transport", () => {
    expect(
      toToolServer({
        ...src,
        server: { ...mcpServerRow, transportType: "sse" },
      }).transport,
    ).toBeNull();
    expect(
      toToolServer({
        ...src,
        server: { ...mcpServerRow, transportType: "stdio" },
      }).transport,
    ).toBe("stdio");
  });

  it("never imported and no credential read as null", () => {
    const draft = toToolServer({
      server: mcpServerRow,
      snapshots: { descriptorCount: 0, lastCapturedAt: null },
      credentialPublicId: null,
    });
    expect(draft.lastImportAt).toBeNull();
    expect(draft.connectionId).toBeNull();
  });

  it("a corrupt discovered_tools value is not counted as zero", () => {
    const draft = toToolServer({
      ...src,
      server: { ...mcpServerRow, discoveredTools: { not: "a list" } },
    });
    expect(draft.toolCount).toBeNaN();
  });
});

describe("toDeclaredToolVersion", () => {
  it("maps the declared version and leaves the unclassified fields null", () => {
    expect(
      toDeclaredToolVersion({ tool: toolRow, version: toolVersionRow }),
    ).toEqual({
      name: "deploy_preview",
      version: "2",
      serverId: null,
      risk: "high",
      sideEffect: null,
      egress: null,
      consequenceTags: null,
      schemaOrigin: "declared",
      schemaDigest: `sha256:${"a".repeat(64)}`,
      price: null,
      credential: { connectionKind: null, downscope: null },
      measures: {
        amount: null,
        currency: null,
        counterparty: null,
        idempotencyKey: null,
      },
      beltCount: null,
      calls30d: null,
    });
  });

  it("read_only reads as a read side effect", () => {
    expect(
      toDeclaredToolVersion({
        tool: toolRow,
        version: { ...toolVersionRow, readOnly: true },
      }).sideEffect,
    ).toBe("read");
  });

  it("an mcp-sourced declaration was imported, not declared", () => {
    expect(
      toDeclaredToolVersion({
        tool: { ...toolRow, source: "mcp" },
        version: toolVersionRow,
      }).schemaOrigin,
    ).toBe("imported");
  });

  it("a slug outside the tool-name vocabulary and an unknown risk grade are null", () => {
    const draft = toDeclaredToolVersion({
      tool: { ...toolRow, slug: "deploy-preview" },
      version: { ...toolVersionRow, riskGrade: "severe" },
    });
    expect(draft.name).toBeNull();
    expect(draft.risk).toBeNull();
  });
});

describe("toImportedToolVersions", () => {
  const first = {
    serverPublicId: mcpServerRow.publicId,
    toolName: snapshotRow.toolName,
    schemaJson: snapshotRow.schemaJson,
    firstCapturedAt: T0,
  };

  it("numbers distinct descriptors per tool in order of first capture", () => {
    const changed = {
      ...first,
      schemaJson: { ...(snapshotRow.schemaJson as object), description: "v2" },
      firstCapturedAt: T1,
    };
    const drafts = toImportedToolVersions([changed, first]);
    expect(drafts.map((d) => [d.name, d.version, d.schemaDigest])).toEqual([
      ["create_pull_request", "1", descriptorDigest(first.schemaJson)],
      ["create_pull_request", "2", descriptorDigest(changed.schemaJson)],
    ]);
    expect(drafts[0]).toMatchObject({
      serverId: "mcs-01k5rsgithub0000000000",
      schemaOrigin: "imported",
      risk: null,
      sideEffect: null,
      consequenceTags: null,
    });
  });

  it("a re-captured identical descriptor is the same version", () => {
    const reordered = {
      ...first,
      schemaJson: {
        inputSchema: { required: ["title"], type: "object" },
        description: "Open a pull request",
        name: "create_pull_request",
      },
      firstCapturedAt: T1,
    };
    expect(toImportedToolVersions([first, reordered])).toHaveLength(1);
  });

  it("keeps tools on different servers apart", () => {
    const other = { ...first, serverPublicId: "mcs_01k5rsother00000000000" };
    expect(
      toImportedToolVersions([first, other]).map((d) => [
        d.serverId,
        d.version,
      ]),
    ).toEqual([
      ["mcs-01k5rsgithub0000000000", "1"],
      ["mcs-01k5rsother00000000000", "1"],
    ]);
  });

  it("a tool name outside the vocabulary is null", () => {
    expect(
      toImportedToolVersions([{ ...first, toolName: "list-issues" }])[0]?.name,
    ).toBeNull();
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(
      canonicalJson({ b: [{ d: 1, c: null }], a: "x", z: undefined }),
    ).toBe('{"a":"x","b":[{"c":null,"d":1}]}');
  });
});

describe("connections", () => {
  it("maps a data-source connection, leaving review and grants unrecorded", () => {
    expect(
      toSourceConnection({
        connection: sourceConnectionRow,
        ownerPublicId: "usr_01k5rsmarcus0000000000",
      }),
    ).toEqual({
      id: "con_01k5rslinear0000000000",
      kind: "oauth",
      name: "Linear",
      ownerId: "usr_01k5rsmarcus0000000000",
      serverIds: [],
      reviewedOn: null,
      reviewOn: null,
      grants30d: null,
      status: "active",
      requiresMandate: null,
      downscope: null,
    });
  });

  it.each([
    ["api_key_secret", "api_key"],
    ["bearer_token", "api_key"],
    ["aws_cross_account_role", "cloud_role"],
    ["basic_auth", null],
    ["public", null],
  ])("auth scheme %s → kind %s", (authScheme, kind) => {
    expect(
      toSourceConnection({
        connection: { ...sourceConnectionRow, authScheme },
        ownerPublicId: null,
      }).kind,
    ).toBe(kind);
  });

  it("a paused or erroring source has no status word", () => {
    expect(
      toSourceConnection({
        connection: { ...sourceConnectionRow, status: "paused" },
        ownerPublicId: null,
      }).status,
    ).toBeNull();
  });

  it("maps an MCP credential to the server it backs", () => {
    expect(
      toMcpCredentialConnection({
        credential: credentialRow,
        server: mcpServerRow,
        ownerPublicId: null,
      }),
    ).toMatchObject({
      id: "mcrd_01k5rsgithubcred00000",
      kind: "oauth",
      name: "GitHub",
      ownerId: null,
      serverIds: ["mcs-01k5rsgithub0000000000"],
      status: "expired",
    });
  });

  it("a credential with no live server and an unknown kind leaves both null", () => {
    const draft = toMcpCredentialConnection({
      credential: { ...credentialRow, authKind: "passkey", status: "revoked" },
      server: null,
      ownerPublicId: null,
    });
    expect(draft).toMatchObject({
      kind: null,
      name: null,
      serverIds: [],
      status: "revoked",
    });
    expect(
      toMcpCredentialConnection({
        credential: { ...credentialRow, authKind: "secret", status: "active" },
        server: null,
        ownerPublicId: null,
      }),
    ).toMatchObject({ kind: "api_key", status: "active" });
  });
});

describe("toKillSwitch", () => {
  const src = {
    deny: emergencyDenyRow,
    activatedByPublicId: "usr_01k5rsdana00000000000",
    deactivatedByPublicId: null,
  };

  it("maps an active capability deny, parsing through the view model", () => {
    const draft = toKillSwitch(src);
    expect(draft).toEqual({
      id: "emd_01k5rsdeny00000000000",
      level: "tool_version",
      target: "dispatch_tacho_command",
      on: true,
      headline: false,
      flippedById: "usr_01k5rsdana00000000000",
      flippedAt: "2026-09-11T09:14:02.000Z",
      reason: "credential probe from an unenrolled host",
      blastRadius: {
        agents: null,
        toolVersions: null,
        mandates: null,
        runsInFlight: null,
        grants24h: null,
      },
    });
    expect(KillSwitch.safeParse(draft).success).toBe(true);
  });

  it("a deactivated deny names who and when it was turned off", () => {
    const T2 = new Date("2026-09-12T10:00:00.000Z");
    expect(
      toKillSwitch({
        deny: { ...emergencyDenyRow, active: false, deactivatedAt: T2 },
        activatedByPublicId: "usr_01k5rsdana00000000000",
        deactivatedByPublicId: "usr_01k5rsmarcus0000000000",
      }),
    ).toMatchObject({
      on: false,
      flippedById: "usr_01k5rsmarcus0000000000",
      flippedAt: "2026-09-12T10:00:00.000Z",
    });
  });

  it("a principal-narrowed or resource-scope deny has no honest level", () => {
    expect(
      toKillSwitch({
        ...src,
        deny: {
          ...emergencyDenyRow,
          principalId: "0192d4a8-7c1e-7a00-8000-0000000a9e47",
        },
      }).level,
    ).toBeNull();
    expect(
      toKillSwitch({
        ...src,
        deny: {
          ...emergencyDenyRow,
          denyKind: "resource_scope",
          capabilityId: null,
          resourceScopeDigest: `sha256:${"b".repeat(64)}`,
        },
      }),
    ).toMatchObject({ level: null, target: `sha256:${"b".repeat(64)}` });
  });
});

describe("settle", () => {
  const View = z.object({
    id: z.string(),
    count: z.number().int(),
    nested: z.object({ tag: z.enum(["a", "b"]) }),
  });

  it("returns the parsed rows when every draft fits", () => {
    const row = { id: "x", count: 1, nested: { tag: "a" } };
    expect(settle(View, [row])).toEqual({ kind: "ok", value: [row] });
    expect(settle(View, [])).toEqual({ kind: "ok", value: [] });
  });

  it("reports null fields the view will not take as unrecorded, by field path", () => {
    expect(
      settle(View, [
        { id: "x", count: null, nested: { tag: null } },
        { id: "y", count: null, nested: { tag: "b" } },
      ]),
    ).toEqual({ kind: "unrecorded", paths: ["count", "nested.tag"] });
  });

  it("reports a produced value the view rejects as a mismatch, even beside nulls", () => {
    expect(
      settle(View, [{ id: "x", count: null, nested: { tag: "c" } }]),
    ).toEqual({ kind: "mismatch", paths: ["nested.tag"] });
  });

  it("a missing key is a mismatch, not an unrecorded field", () => {
    expect(settle(View, [{ id: "x", nested: { tag: "a" } }])).toEqual({
      kind: "mismatch",
      paths: ["count"],
    });
  });
});
