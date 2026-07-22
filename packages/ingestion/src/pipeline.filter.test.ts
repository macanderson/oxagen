/**
 * Pipeline filter integration tests.
 *
 * These tests verify that filter enforcement in runPipeline correctly reads
 * deliveryConfig from the PipelineContext and short-circuits the pipeline at
 * the appropriate stage.
 *
 * External deps (resolveEntity, embedEntity) are mocked so no live graph or
 * AI gateway is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Register connectors before importing pipeline
import "./connectors/github/index";
import "./connectors/custom-sql/index";

vi.mock("./dedup/resolve", () => ({
  resolveEntity: vi.fn().mockResolvedValue({
    principalNodeId: "node-filter-test-1",
    action: "created_principal",
    confidence: 1.0,
  }),
}));

vi.mock("./embed/index", () => ({
  renderEntityText: vi.fn().mockReturnValue("task  Fix bug  state:open"),
  embedEntity: vi.fn().mockResolvedValue(undefined),
}));

import { runPipeline } from "./pipeline";
import { embedEntity } from "./embed/index";
import type { RawIngestEvent } from "./types";
import type { PipelineContext } from "./pipeline";
import type { DeliveryConfig } from "./filters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<RawIngestEvent> = {}): RawIngestEvent {
  return {
    connectionId: "conn-filter-1",
    workspaceId: "ws-filter",
    orgId: "org-filter",
    connectorType: "github",
    sourceRecordType: "pull_request",
    idempotencyKey: "github:conn-filter-1:pull_request:7",
    payload: {
      number: 7,
      title: "Add feature flag system",
      body: "Implements a basic flag system.",
      state: "open",
      user: { login: "bob" },
      labels: [{ name: "feature" }, { name: "ux" }],
      html_url: "https://github.com/acme/api/pull/7",
    },
    receivedAt: "2024-03-01T10:00:00Z",
    ...overrides,
  };
}

function makeCtx(
  deliveryConfig: DeliveryConfig | null = null,
): PipelineContext {
  return {
    orgId: "org-filter",
    getMapping: vi.fn().mockResolvedValue({
      oxagenEntityType: "code_change",
      propertyMappings: {},
    }),
    getDeliveryConfig: vi.fn().mockResolvedValue(deliveryConfig),
  };
}

// ---------------------------------------------------------------------------
// Stage 1: Record type filter
// ---------------------------------------------------------------------------

describe("runPipeline — Stage 1: record type filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through when recordTypeFilters is empty", async () => {
    const event = makeEvent({ sourceRecordType: "commit" });
    const ctx = makeCtx({ recordTypeFilters: [] });
    const result = await runPipeline(event, ctx);
    expect(result).not.toBeNull();
    expect((result as { filtered?: boolean }).filtered).toBeUndefined();
  });

  it("passes through when recordTypeFilters is absent (no deliveryConfig)", async () => {
    const event = makeEvent({ sourceRecordType: "commit" });
    const ctx = makeCtx(null);
    const result = await runPipeline(event, ctx);
    expect(result).not.toBeNull();
    expect((result as { filtered?: boolean }).filtered).toBeUndefined();
  });

  it("passes through when sourceRecordType is in the allow list", async () => {
    const event = makeEvent({ sourceRecordType: "pull_request" });
    const ctx = makeCtx({ recordTypeFilters: ["pull_request", "issue"] });
    const result = await runPipeline(event, ctx);
    expect(result).not.toBeNull();
    expect((result as { filtered?: boolean }).filtered).toBeUndefined();
  });

  it("returns FilteredResult when sourceRecordType is NOT in the allow list", async () => {
    const event = makeEvent({ sourceRecordType: "commit" });
    const ctx = makeCtx({ recordTypeFilters: ["pull_request", "issue"] });
    const result = await runPipeline(event, ctx);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      filtered: true,
      reason: "record_type_not_allowed",
      sourceRecordType: "commit",
      connectionId: "conn-filter-1",
    });
    // getMapping should NOT have been called (short-circuit)
    expect(ctx.getMapping).not.toHaveBeenCalled();
  });

  it("does not call embedEntity for filtered records", async () => {
    const event = makeEvent({ sourceRecordType: "commit" });
    const ctx = makeCtx({ recordTypeFilters: ["pull_request"] });
    await runPipeline(event, ctx);
    expect(embedEntity).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stage 2: Path filter
// ---------------------------------------------------------------------------

describe("runPipeline — Stage 2: path filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makePathRecord(path: string): RawIngestEvent {
    return makeEvent({
      connectorType: "custom-sql",
      sourceRecordType: "row",
      payload: {
        id: "row-1",
        path,
        content: "provider record content",
      },
    });
  }

  it("filters a provider record whose path matches an excluded tree", async () => {
    const event = makePathRecord("node_modules/react/index.js");
    const ctx = makeCtx({ pathFilters: ["node_modules/**"] });
    const result = await runPipeline(event, ctx);
    expect(result).toMatchObject({
      filtered: true,
      reason: "path_filtered",
      sourceRecordType: "row",
    });
    expect(embedEntity).not.toHaveBeenCalled();
  });

  it("filters a file in dist/", async () => {
    const event = makePathRecord("dist/bundle.min.js");
    const ctx = makeCtx({ pathFilters: ["dist/**"] });
    const result = await runPipeline(event, ctx);
    expect(result).toMatchObject({ filtered: true, reason: "path_filtered" });
  });

  it("does not filter provider records outside excluded paths", async () => {
    const event = makePathRecord("records/current.json");
    const ctx = makeCtx({ pathFilters: ["node_modules/**", "dist/**"] });
    const result = await runPipeline(event, ctx);
    expect((result as { filtered?: boolean }).filtered).toBeUndefined();
  });

  it("passes through non-source records without path property", async () => {
    // pull_request payload has no 'path'
    const event = makeEvent({ sourceRecordType: "pull_request" });
    const ctx = makeCtx({ pathFilters: ["node_modules/**"] });
    const result = await runPipeline(event, ctx);
    expect((result as { filtered?: boolean }).filtered).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 2: Label filter
// ---------------------------------------------------------------------------

describe("runPipeline — Stage 2: label filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters issues with a matching label", async () => {
    const event = makeEvent({
      sourceRecordType: "issue",
      payload: {
        number: 55,
        title: "Internal tooling issue",
        body: "",
        state: "open",
        user: { login: "carol" },
        labels: [{ name: "internal" }, { name: "bug" }],
        html_url: "https://github.com/acme/app/issues/55",
      },
    });
    const ctx = makeCtx({ labelFilters: ["internal"] });
    const result = await runPipeline(event, ctx);
    expect(result).toMatchObject({
      filtered: true,
      reason: "label_filtered",
      sourceRecordType: "issue",
    });
    expect(embedEntity).not.toHaveBeenCalled();
  });

  it("filters PRs using glob label patterns", async () => {
    const event = makeEvent({
      payload: {
        number: 88,
        title: "Hotfix login issue",
        body: "",
        state: "open",
        user: { login: "dan" },
        labels: [{ name: "skip-inference-flag" }],
        html_url: "https://github.com/acme/app/pull/88",
      },
    });
    const ctx = makeCtx({ labelFilters: ["skip-*"] });
    const result = await runPipeline(event, ctx);
    expect(result).toMatchObject({ filtered: true, reason: "label_filtered" });
  });

  it("passes through when no labels match the filter patterns", async () => {
    const event = makeEvent(); // has labels: ["feature", "ux"]
    const ctx = makeCtx({ labelFilters: ["internal", "skip"] });
    const result = await runPipeline(event, ctx);
    expect((result as { filtered?: boolean }).filtered).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 5: Legacy embedding opt-out
// ---------------------------------------------------------------------------

describe("runPipeline — Stage 5: embedding opt-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips embed when the legacy semanticInference.enabled flag is false", async () => {
    const event = makeEvent();
    const ctx = makeCtx({ semanticInference: { enabled: false } });
    const result = await runPipeline(event, ctx);

    expect(result).not.toBeNull();
    expect((result as { embedded?: boolean }).embedded).toBe(false);
    expect(embedEntity).not.toHaveBeenCalled();
  });

  it("skips embed for a specific record type disabled in perRecordType", async () => {
    const event = makeEvent({ sourceRecordType: "commit" });
    const ctx = makeCtx({
      semanticInference: {
        enabled: true,
        perRecordType: { commit: false, pull_request: true },
      },
    });
    const result = await runPipeline(event, ctx);

    expect((result as { embedded?: boolean }).embedded).toBe(false);
    expect(embedEntity).not.toHaveBeenCalled();
  });

  it("runs embed when the legacy flag is enabled globally", async () => {
    const event = makeEvent();
    const ctx = makeCtx({ semanticInference: { enabled: true } });
    const result = await runPipeline(event, ctx);

    expect((result as { embedded?: boolean }).embedded).toBe(true);
    expect(embedEntity).toHaveBeenCalledOnce();
  });

  it("runs embed when no deliveryConfig provided (default enabled)", async () => {
    const event = makeEvent();
    const ctx = makeCtx(null); // no deliveryConfig
    const result = await runPipeline(event, ctx);

    expect((result as { embedded?: boolean }).embedded).toBe(true);
    expect(embedEntity).toHaveBeenCalledOnce();
  });

  it("runs embed for pull_request when perRecordType enables it", async () => {
    const event = makeEvent({ sourceRecordType: "pull_request" });
    const ctx = makeCtx({
      semanticInference: {
        enabled: true,
        perRecordType: { commit: false, pull_request: true },
      },
    });
    const result = await runPipeline(event, ctx);

    expect((result as { embedded?: boolean }).embedded).toBe(true);
    expect(embedEntity).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Combined: record type filter + inference gate
// ---------------------------------------------------------------------------

describe("runPipeline — combined filter scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("record type filter short-circuits before path/label/inference checks", async () => {
    const event = makeEvent({ sourceRecordType: "repository" });
    const ctx = makeCtx({
      recordTypeFilters: ["pull_request", "issue"],
      pathFilters: ["**"], // would filter everything if reached
      labelFilters: ["*"], // would filter everything if reached
      semanticInference: { enabled: false },
    });
    const result = await runPipeline(event, ctx);

    expect(result).toMatchObject({
      filtered: true,
      reason: "record_type_not_allowed",
    });
    // No mapping lookup, no embed
    expect(ctx.getMapping).not.toHaveBeenCalled();
    expect(embedEntity).not.toHaveBeenCalled();
  });

  it("null return from getMapping (no mapping configured) returns null, not FilteredResult", async () => {
    const event = makeEvent();
    const ctx: PipelineContext = {
      orgId: "org-filter",
      getMapping: vi.fn().mockResolvedValue(null),
      getDeliveryConfig: vi.fn().mockResolvedValue(null),
    };
    const result = await runPipeline(event, ctx);
    expect(result).toBeNull();
  });
});
