import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type { BundleSource, Delivery } from "@oxagen/steering-bundle";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  resolve: vi.fn(),
  role: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.db,
}));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolve }));
vi.mock("./lib/capability-role-guard", () => ({
  assertContractRole: mocks.role,
}));

import { tachoMemoriesRecall as contract } from "@oxagen/oxagen/contracts/tacho.memories.recall";
import { renderMemoryRecord } from "./memory/record-file";
import type {
  ActiveRecord,
  MemoryScope,
  RecallItem,
  RecallRequest,
} from "./memory/types";
import { NOTHING_PUBLISHED, type TachoPublished } from "./tacho.published";
import { createTachoMemoriesRecallHandler } from "./tacho.memories.recall";

const HOST = "tch_0123456789abcdefghjkmn";
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-09-27T12:00:00.000Z");
const input = contract.input.parse({
  host_enrollment_id: HOST,
  repository_digests: [DIGEST],
  tools: ["Bash", "Edit"],
  paths: ["apps/api/src/billing.ts"],
  text: "Change the proration rule.",
});
const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "host-key",
  requestId: "req",
  messageId: null,
  surface: "api",
};
const SCOPE: MemoryScope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
const WORKSPACE_STATEMENT = "Run the billing tests before a proration change.";
const ORGANIZATION_STATEMENT = "Ask finance before a proration change.";
const ITEM: RecallItem = {
  id: "billing-tests",
  source: "record",
  statement: WORKSPACE_STATEMENT,
  score: 0.9,
  tokens: 11,
};

const denied = () =>
  new CapabilityError(
    "recall_tacho_memories",
    "authz_denied",
    "Forbidden: host enrollment mismatch",
  );

/** A memory record file as a published version holds it. */
function memoryFile(lineage: string, statement: string): string {
  return renderMemoryRecord({
    lineage,
    kind: "memory",
    statement,
    repos: null,
    appliesTo: null,
    tools: null,
    uri: "https://app.oxagen.ai/runs/arun_01K5QK7D",
    memories: [{ agent: null, run: null, statement, evidence: [] }],
  });
}

/** A published version with only the fields the handler reads. */
function bundle(
  records: Array<{ lineage: string; path: string; blob: string }>,
): Bundle {
  return { records } as unknown as Bundle;
}

/**
 * A published port over `files`, keyed by `<source>:<path>`. A missing file
 * throws the way the version store does.
 */
function port(
  delivery: Delivery,
  files: Record<string, string | Uint8Array>,
) {
  const readAsset = vi.fn(
    async (
      source: BundleSource,
      _bundle: Bundle,
      file: { path: string; blob: string },
    ): Promise<string | Uint8Array> => {
      const content = files[`${source}:${file.path}`];
      if (content === undefined) throw new Error(`no blob ${file.blob}`);
      return content;
    },
  );
  const published: TachoPublished = {
    published: vi.fn(async () => delivery),
    readAsset,
  };
  return { published, readAsset };
}

function handlerWith(published: TachoPublished, items: RecallItem[] = []) {
  const recall = vi.fn(
    async (
      _scope: MemoryScope,
      _request: RecallRequest,
      _records: readonly ActiveRecord[],
    ) => items,
  );
  const handler = createTachoMemoriesRecallHandler({
    published,
    recall,
    now: () => NOW,
  });
  return { recall, handler };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.resolve.mockResolvedValue({ agentKey: "agent.laptop" });
  mocks.role.mockResolvedValue("Owner");
});

describe("recall_tacho_memories", () => {
  it("checks the host key and the role before it reads the port", async () => {
    mocks.role.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { code: "forbidden" }),
    );
    const { published, readAsset } = port(
      { workspace: null, organization: null },
      {},
    );
    const { recall, handler } = handlerWith(published);
    await expect(handler(input, ctx)).rejects.toThrow("Forbidden");
    expect(mocks.resolve).toHaveBeenCalledWith(
      "recall_tacho_memories",
      ctx,
      {},
      HOST,
    );
    expect(mocks.role).toHaveBeenCalledWith(contract, ctx);
    expect(published.published).not.toHaveBeenCalled();
    expect(readAsset).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
  });

  it("recalls nothing from a host whose key names another host", async () => {
    mocks.resolve.mockRejectedValueOnce(denied());
    const { recall, handler } = handlerWith(NOTHING_PUBLISHED);
    await expect(handler(input, ctx)).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(mocks.role).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
  });

  it("recalls with no records while nothing has published", async () => {
    const { recall, handler } = handlerWith(NOTHING_PUBLISHED, [ITEM]);
    await expect(handler(input, ctx)).resolves.toEqual({ items: [ITEM] });
    expect(recall).toHaveBeenCalledTimes(1);
    const [scope, request, records] = recall.mock.calls[0]!;
    expect(scope).toEqual(SCOPE);
    expect(records).toEqual([]);
    expect(request.inApp).toBe(false);
  });

  it("passes the prompt to recall, with no agent and no governance setting", async () => {
    // ADR-238: recall answers steering records only, so it needs neither the
    // host's agent nor recall_unreviewed, which governance/v1 no longer has.
    const { published } = port({ workspace: null, organization: null }, {});
    const { recall, handler } = handlerWith(published);
    await handler(input, ctx);
    expect(recall.mock.calls[0]![1]).toEqual({
      now: NOW,
      inApp: false,
      repositoryDigests: [DIGEST],
      tools: ["Bash", "Edit"],
      paths: ["apps/api/src/billing.ts"],
      text: "Change the proration rule.",
    });
  });

  it("reads the workspace's memory record over the organization's of the same lineage", async () => {
    const path = "steering/memory/billing-tests.md";
    const rule = "steering/rules/ledger.md";
    const workspace = bundle([
      { lineage: "billing-tests", path, blob: "a".repeat(40) },
      { lineage: "ledger", path: rule, blob: "b".repeat(40) },
    ]);
    const organization = bundle([
      { lineage: "billing-tests", path, blob: "c".repeat(40) },
    ]);
    const { published, readAsset } = port(
      { workspace, organization },
      {
        // Bytes, the way a version store may answer.
        [`workspace:${path}`]: new TextEncoder().encode(
          memoryFile("billing-tests", WORKSPACE_STATEMENT),
        ),
        [`organization:${path}`]: memoryFile(
          "billing-tests",
          ORGANIZATION_STATEMENT,
        ),
        [`workspace:${rule}`]: memoryFile("ledger", "Keep the ledger append-only."),
      },
    );
    const { recall, handler } = handlerWith(published);
    await handler(input, ctx);
    expect(published.published).toHaveBeenCalledWith({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId: null,
    });
    expect(readAsset).toHaveBeenCalledTimes(1);
    expect(readAsset).toHaveBeenCalledWith("workspace", workspace, {
      path,
      blob: "a".repeat(40),
    });
    const records = recall.mock.calls[0]![2];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      path,
      lineage: "billing-tests",
      kind: "memory",
      status: "active",
      statement: WORKSPACE_STATEMENT,
      repos: null,
      appliesTo: null,
      tools: null,
    });
  });

  it("leaves out a record it cannot read or parse and recalls the rest", async () => {
    const workspace = bundle([
      { lineage: "gone", path: "steering/memory/gone.md", blob: "d".repeat(40) },
      {
        lineage: "garbled",
        path: "steering/memory/garbled.md",
        blob: "e".repeat(40),
      },
      {
        lineage: "billing-tests",
        path: "steering/memory/billing-tests.md",
        blob: "f".repeat(40),
      },
    ]);
    const { published, readAsset } = port(
      { workspace, organization: null },
      {
        "workspace:steering/memory/garbled.md": "no frontmatter here",
        "workspace:steering/memory/billing-tests.md": memoryFile(
          "billing-tests",
          WORKSPACE_STATEMENT,
        ),
      },
    );
    const { recall, handler } = handlerWith(published);
    await handler(input, ctx);
    expect(readAsset).toHaveBeenCalledTimes(3);
    const records = recall.mock.calls[0]![2];
    expect(records.map((record) => record.lineage)).toEqual(["billing-tests"]);
  });

  it("recalls with no records when the published steering cannot be read", async () => {
    const { published } = port({ workspace: null, organization: null }, {});
    published.published = vi.fn(async () => {
      throw new Error("version store unavailable");
    });
    const { recall, handler } = handlerWith(published, [ITEM]);
    await expect(handler(input, ctx)).resolves.toEqual({ items: [ITEM] });
    expect(recall.mock.calls[0]![2]).toEqual([]);
  });
});
