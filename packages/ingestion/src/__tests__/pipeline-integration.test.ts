/**
 * Integration tests for the full 6-stage ingestion pipeline.
 *
 * Unlike the top-level pipeline.test.ts (which validates overall flow control),
 * this file asserts the Neo4j mutation layer specifically:
 *
 * - resolveEntity is called with a correctly-shaped EntityMutation
 * - upsertEntityNode is invoked with the right naturalKey + MERGE params
 * - embedEntity (via embedText) is called after dedup resolves a principal
 * - All ingestion stages run without throwing for a well-formed connector event
 *
 * The test mocks:
 *   - scopedSession   (Neo4j — no live graph required)
 *   - embedText       (@oxagen/ai — no AI gateway required)
 *   - generateObjectFor (not used in runPipeline directly, but mocked defensively)
 *
 * Connectors are registered via side-effect imports (github, custom-sql).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  // Neo4j session
  sessionRun: vi.fn(),
  sessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  // AI
  embedText: vi.fn(),
  generateObjectFor: vi.fn(),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedText,
  generateObjectFor: mocks.generateObjectFor,
}));

// Register built-in connectors before importing pipeline
import "../connectors/github/index";
import "../connectors/custom-sql/index";

import { runPipeline } from "../pipeline";
import type { RawIngestEvent, PipelineResult } from "../types";
import type { PipelineContext } from "../pipeline";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a RawIngestEvent for a GitHub push event. */
function makeGithubEvent(
  overrides: Partial<RawIngestEvent> = {},
): RawIngestEvent {
  return {
    connectionId: "conn-integration-1",
    workspaceId: "ws-integration",
    orgId: "org-integration",
    connectorType: "github",
    sourceRecordType: "pull_request",
    idempotencyKey: "github:conn-integration-1:pull_request:99",
    payload: {
      number: 99,
      title: "Add user onboarding flow",
      body: "This PR implements the onboarding wizard described in the product spec.",
      state: "open",
      user: { login: "alice" },
      labels: [{ name: "feature" }, { name: "ux" }],
      html_url: "https://github.com/oxagen/app/pull/99",
    },
    receivedAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

/** Build a PipelineContext that returns a real entity type mapping. */
function makeCtx(overrides?: {
  oxagenEntityType?: string;
  propertyMappings?: Record<string, string>;
  returnNull?: boolean;
}): PipelineContext {
  return {
    orgId: "org-integration",
    getMapping: vi.fn().mockResolvedValue(
      overrides?.returnNull
        ? null
        : {
            oxagenEntityType: overrides?.oxagenEntityType ?? "code_change",
            propertyMappings: overrides?.propertyMappings ?? {},
          },
    ),
  };
}

/** Shared principal node UUID returned by the mock Neo4j session. */
const PRINCIPAL_NODE_ID = "uuid-principal-integration-1";

/** Set up Neo4j session mocks for a successful dedup + upsert flow. */
function setupNeo4jMocks() {
  // Pass A: naturalKey lookup — no existing node (triggers Pass B)
  mocks.sessionRun.mockResolvedValueOnce({ records: [] });

  // embedText (called during Pass B dedup)
  mocks.embedText.mockResolvedValue(
    Array.from({ length: 1536 }, (_, i) => i / 1536),
  );

  // Pass B: vector similarity search — no similar candidates (creates new principal)
  mocks.sessionRun.mockResolvedValueOnce({ records: [] });

  // upsertEntityNode (new principal created)
  mocks.sessionRun.mockResolvedValueOnce({
    records: [{ get: vi.fn().mockReturnValue(PRINCIPAL_NODE_ID) }],
  });

  // embedEntity → upsertEmbedding (SET embedding on the new node)
  mocks.sessionRun.mockResolvedValueOnce({ records: [] });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runPipeline — full 6-stage integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset once-queues on sessionRun and embedText so tests don't bleed into each other.
    // clearAllMocks() clears history but NOT once-queues (vitest behavior).
    // mockReset() clears once-queues + persistent implementations.
    mocks.sessionRun.mockReset();
    mocks.embedText.mockReset();
    mocks.generateObjectFor.mockReset();
    // Re-establish session close resolved value after reset
    mocks.sessionClose.mockResolvedValue(undefined);
    // Re-establish scopedSession to return the shared session mock
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
  });

  it("returns null when getMapping returns null (record type not configured)", async () => {
    setupNeo4jMocks();
    const event = makeGithubEvent();
    const ctx = makeCtx({ returnNull: true });

    const result = await runPipeline(event, ctx);

    expect(result).toBeNull();
    expect(ctx.getMapping).toHaveBeenCalledWith(
      "conn-integration-1",
      "pull_request",
    );
    // No Neo4j queries should have run
    expect(mocks.sessionRun).not.toHaveBeenCalled();
  });

  it("all stages run without throwing for a well-formed github event", async () => {
    setupNeo4jMocks();
    const event = makeGithubEvent();
    const ctx = makeCtx();

    await expect(runPipeline(event, ctx)).resolves.not.toThrow();
  });

  it("returns a complete PipelineResult with all required fields", async () => {
    setupNeo4jMocks();
    const event = makeGithubEvent();
    const ctx = makeCtx();

    const result = (await runPipeline(event, ctx)) as PipelineResult;

    expect(result).not.toBeNull();
    expect(result.naturalKey).toBe("github:conn-integration-1:99");
    expect(result.operation).toBe("insert");
    expect(result.embedded).toBe(true);
    expect(typeof result.dedup.principalNodeId).toBe("string");
    expect(result.dedup.principalNodeId ?? "").not.toBe("");
  });

  it("upsertEntityNode is called with correct MERGE params", async () => {
    setupNeo4jMocks();
    const event = makeGithubEvent();
    const ctx = makeCtx({
      oxagenEntityType: "code_change",
      propertyMappings: {},
    });

    await runPipeline(event, ctx);

    // upsertEntityNode runs a MERGE — find the specific call (after Pass A + Pass B session.run).
    // The real label (`CodeChange`) is primary, `:EntityNode` secondary.
    // Labels are PascalCase (sanitizeLabel); the entityType *property* stays the
    // lowercase slug (`code_change`).
    const upsertCall = mocks.sessionRun.mock.calls.find(
      ([cypher]) =>
        typeof cypher === "string" &&
        cypher.includes("MERGE (n:`CodeChange`:`EntityNode`") &&
        cypher.includes("RETURN n.publicId AS nodeId"),
    ) as [string, Record<string, unknown>] | undefined;

    expect(upsertCall).toBeDefined();
    const [cypher, params] = upsertCall!;

    // naturalKey convention: {connectorType}:{connectionId}:{externalId}
    expect(cypher).toContain(
      "MERGE (n:`CodeChange`:`EntityNode` {naturalKey: $naturalKey, orgId: $orgId})",
    );
    expect(params["naturalKey"]).toBe("github:conn-integration-1:99");
    expect(params["entityType"]).toBe("code_change");
    // upsertEntityNode binds $orgId explicitly in its params, rather than
    // relying on scopedSession's own orgId/workspaceId injection. This mock
    // replaces scopedSession with a bare fn that does not inject, so the
    // captured params reflect exactly what upsertEntityNode passes.
    expect(params["orgId"]).toBe("org-integration");
    expect(params["connectionId"]).toBe("conn-integration-1");
    expect(params["workspaceId"]).toBe("ws-integration");

    // properties must be JSON-serialized (Neo4j stores strings)
    expect(typeof params["properties"]).toBe("string");
    const props = JSON.parse(params["properties"] as string) as Record<
      string,
      unknown
    >;
    expect(props["title"]).toBe("Add user onboarding flow");
    expect(props["state"]).toBe("open");
  });

  it("embedText is called with the correct surface telemetry", async () => {
    setupNeo4jMocks();
    const event = makeGithubEvent();
    const ctx = makeCtx();

    await runPipeline(event, ctx);

    // embedText is called twice: once for Pass B dedup, once for embedEntity
    expect(mocks.embedText).toHaveBeenCalledTimes(2);

    // The first call is for dedup — telemetry surface must be "ingestion"
    const [_text1, opts1] = mocks.embedText.mock.calls[0] as [
      string,
      {
        telemetry: {
          surface: string;
          orgId: string;
          executionStepId: string | null;
        };
      },
    ];
    expect(opts1.telemetry.surface).toBe("ingestion");
    expect(opts1.telemetry.orgId).toBe("org-integration");
    // No execution step for ingestion dedup embeds: executionStepId must be null,
    // never a synthesized `dedup:<key>` string (that non-UUID value flooded the
    // token_usage UUID column with CANNOT_PARSE_INPUT_ASSERTION_FAILED).
    expect(opts1.telemetry.executionStepId).toBeNull();
  });

  it("applies property mappings — renames source field to canonical name", async () => {
    setupNeo4jMocks();
    // Map 'title' → 'summary'
    const event = makeGithubEvent();
    const ctx = makeCtx({
      oxagenEntityType: "task",
      propertyMappings: { title: "summary" },
    });

    await runPipeline(event, ctx);

    // Find the upsertEntityNode MERGE call (`Task` is the primary label,
    // PascalCase via sanitizeLabel)
    const upsertCall = mocks.sessionRun.mock.calls.find(
      ([cypher]) =>
        typeof cypher === "string" &&
        cypher.includes("MERGE (n:`Task`:`EntityNode`") &&
        cypher.includes("RETURN n.publicId"),
    ) as [string, Record<string, unknown>] | undefined;

    expect(upsertCall).toBeDefined();
    const props = JSON.parse(upsertCall![1]["properties"] as string) as Record<
      string,
      unknown
    >;
    expect(props["summary"]).toBe("Add user onboarding flow"); // renamed
    expect(props["title"]).toBeUndefined(); // original key removed
  });

  it("dedup Pass A: when naturalKey already exists, skips Pass B and returns updated_principal", async () => {
    // Pass A: naturalKey found → triggers updated_principal path
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: (_key: string) => "existing-principal-uuid" }],
    });

    // upsertEntityNode call inside resolveEntity's Pass A branch (ON MATCH SET update)
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: (_key: string) => "existing-principal-uuid" }],
    });

    // embedText for embedEntity (Pass B embedding is skipped = only one embedText call)
    mocks.embedText.mockResolvedValue(
      Array.from({ length: 1536 }, (_, i) => i / 1536),
    );

    // upsertEmbedding (SET embedding on existing node)
    mocks.sessionRun.mockResolvedValueOnce({ records: [] });

    const event = makeGithubEvent();
    const ctx = makeCtx();
    const result = (await runPipeline(event, ctx)) as PipelineResult;

    expect(result.dedup.action).toBe("updated_principal");
    expect(result.dedup.principalNodeId).toBe("existing-principal-uuid");
    expect(result.dedup.confidence).toBe(1.0);
    expect(result.dedup.matchReason).toBe("natural_key_exact");

    // embedText only called once (for embedEntity — Pass B embedding skipped)
    expect(mocks.embedText).toHaveBeenCalledOnce();
  });

  it("throws when connector is not registered", async () => {
    const event = makeGithubEvent({ connectorType: "not-registered" });
    const ctx = makeCtx();

    await expect(runPipeline(event, ctx)).rejects.toThrow(
      'No connector registered for "not-registered"',
    );
    expect(mocks.sessionRun).not.toHaveBeenCalled();
  });
});
