// The pull request sync's step rules (ADR-288), with every read and write a
// fake: when the forge is read, which links are written, when a head needs a
// capture, and what a capture records with and without a diff store.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type {
  ForgePullRequestFacts,
  ForgePullRequestSyncRequest,
} from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import type { DiffStore } from "./diff-store";
import {
  captureObserved,
  type ForgeSyncDeps,
  recordObserved,
  upsertObserved,
} from "./sync";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const FACTS: ForgePullRequestFacts = {
  host: "github.com",
  providerRepositoryId: "991",
  repository: "acme/api",
  number: 42,
  url: "https://github.com/acme/api/pull/42",
  title: "Cut the release",
  authorLogin: "octo",
  state: "open",
  draft: false,
  baseRef: "main",
  headRef: "release/3.2",
  headSha: HEAD,
  baseSha: BASE,
  mergeBaseSha: null,
  mergeCommitSha: null,
  mergedAt: null,
  closedAt: null,
  sourceUpdatedAt: "2026-10-02T10:00:00.000Z",
};
const REQUEST: ForgePullRequestSyncRequest = {
  ...SCOPE,
  provider: "github",
  repository: "acme/api",
  number: 42,
  pullKey: `${SCOPE.workspaceId}:github:acme/api#42`,
};
const TARGET = {
  headSha: HEAD,
  baseSha: BASE,
  baseRef: "main",
  mergeBaseSha: null,
  providerRepositoryId: "991",
  number: 42,
};
const NOW = new Date("2026-10-03T00:00:00Z");

function store(): DiffStore & { puts: [string, Uint8Array, unknown][] } {
  const puts: [string, Uint8Array, unknown][] = [];
  return {
    name: "s3",
    bucket: "diffs",
    puts,
    putOnce: async (key, bytes, opts) => {
      puts.push([key, bytes, opts]);
      return "written";
    },
    get: async () => null,
  };
}

function deps(over: Partial<ForgeSyncDeps> = {}): ForgeSyncDeps {
  return {
    readFacts: vi.fn(async () => FACTS),
    upsert: vi.fn(async () => "pr-1"),
    revisionStatus: vi.fn(async () => null),
    runPublicId: vi.fn(async () => "tse_4q8r1t6v3x5z0b2d7h2k9m"),
    linkRun: vi.fn(async () => 1),
    workOrdersOf: vi.fn(async () => ["order-1", "order-2"]),
    linkWorkOrders: vi.fn(
      async (_scope: unknown, _id: unknown, ids: readonly string[]) => ids.length,
    ),
    store: () => null,
    readDiff: vi.fn(async () => ({
      kind: "files_only" as const,
      mergeBaseSha: "d".repeat(40),
      files: [
        { path: "a.ts", status: "modified" as const, additions: 3, deletions: 1 },
      ],
      limitations: [],
    })),
    record: vi.fn(async () => ({
      revisionId: "rev-1",
      diffStatus: "unconfigured" as const,
      newlyStored: false,
    })),
    now: () => NOW,
    ...over,
  };
}

describe("upsertObserved", () => {
  it("writes a delivery's facts without reading the forge", async () => {
    const d = deps();
    const out = await upsertObserved(d, { ...REQUEST, facts: FACTS });
    expect(d.readFacts).not.toHaveBeenCalled();
    expect(d.upsert).toHaveBeenCalledWith(SCOPE, { ...REQUEST, facts: FACTS }, FACTS, NOW);
    expect(out).toEqual({
      outcome: "recorded",
      pullRequestId: "pr-1",
      target: TARGET,
      needsCapture: true,
      links: 0,
    });
  });

  it("reads the forge once for a link, and links the run and its work orders in this repository", async () => {
    const d = deps();
    const out = await upsertObserved(d, {
      ...REQUEST,
      link: { rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1", opened: true },
    });
    expect(d.readFacts).toHaveBeenCalledTimes(1);
    expect(d.linkRun).toHaveBeenCalledWith(
      SCOPE,
      "pr-1",
      "tse_4q8r1t6v3x5z0b2d7h2k9m",
      "opened",
    );
    expect(d.workOrdersOf).toHaveBeenCalledWith(
      SCOPE,
      "tse_4q8r1t6v3x5z0b2d7h2k9m",
      "acme/api",
    );
    expect(d.linkWorkOrders).toHaveBeenCalledWith(
      SCOPE,
      "pr-1",
      ["order-1", "order-2"],
      "tse_4q8r1t6v3x5z0b2d7h2k9m",
    );
    expect(out.links).toBe(3);
  });

  it("links nothing when the link's session is not a root session in this workspace (negative)", async () => {
    const d = deps({ runPublicId: vi.fn(async () => null) });
    const out = await upsertObserved(d, {
      ...REQUEST,
      link: { rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1", opened: false },
    });
    expect(d.linkRun).not.toHaveBeenCalled();
    expect(d.linkWorkOrders).not.toHaveBeenCalled();
    expect(out).toMatchObject({ outcome: "recorded", links: 0 });
  });

  it.each(["no_connection", "unreadable"] as const)(
    "writes nothing when the forge read answers %s (negative)",
    async (answer) => {
      const d = deps({ readFacts: vi.fn(async () => answer) });
      await expect(upsertObserved(d, REQUEST)).resolves.toEqual({
        outcome: answer,
        needsCapture: false,
        links: 0,
      });
      expect(d.upsert).not.toHaveBeenCalled();
    },
  );

  it("captures no head that already has a stored, refused, or unreadable diff", async () => {
    for (const held of ["stored", "too_large", "unreadable"] as const) {
      const d = deps({ revisionStatus: vi.fn(async () => held), store: store });
      const out = await upsertObserved(d, { ...REQUEST, facts: FACTS });
      expect(out.needsCapture).toBe(false);
    }
  });

  it("captures an unconfigured head again only once a diff store exists", async () => {
    const without = deps({ revisionStatus: vi.fn(async () => "unconfigured" as const) });
    expect((await upsertObserved(without, { ...REQUEST, facts: FACTS })).needsCapture).toBe(false);
    const withStore = deps({
      revisionStatus: vi.fn(async () => "unconfigured" as const),
      store: store,
    });
    expect((await upsertObserved(withStore, { ...REQUEST, facts: FACTS })).needsCapture).toBe(true);
  });
});

describe("captureObserved", () => {
  it("records the file list as unconfigured, and asks for no bytes, with no diff store", async () => {
    const d = deps();
    const capture = await captureObserved(d, REQUEST, TARGET);
    expect(d.readDiff).toHaveBeenCalledWith(SCOPE, REQUEST, TARGET, false);
    expect(capture).toEqual({
      diffStatus: "unconfigured",
      diffStore: null,
      diffKey: null,
      diffSha256: null,
      diffBytes: null,
      mergeBaseSha: "d".repeat(40),
      files: [{ path: "a.ts", status: "modified", additions: 3, deletions: 1 }],
      filesChanged: 1,
      additions: 3,
      deletions: 1,
      complete: false,
      limitations: [],
    });
  });

  it("puts the bytes under a tenant-first key that names the head, with their sha256", async () => {
    const s = store();
    const bytes = new TextEncoder().encode("diff --git a/a.ts b/a.ts\n");
    const d = deps({
      store: () => s,
      readDiff: vi.fn(async () => ({
        kind: "diff" as const,
        bytes,
        mergeBaseSha: "d".repeat(40),
        files: [],
        limitations: [],
      })),
    });
    const capture = await captureObserved(d, REQUEST, TARGET);
    const key = `pr-diffs/${SCOPE.orgId}/${SCOPE.workspaceId}/github/991/42/${HEAD}.diff`;
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]?.[0]).toBe(key);
    expect(capture).toMatchObject({
      diffStatus: "stored",
      diffStore: "s3",
      diffKey: key,
      diffBytes: bytes.byteLength,
      complete: true,
    });
    expect(capture.diffSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.puts[0]?.[2]).toEqual({
      sha256: capture.diffSha256,
      contentType: "text/x-diff; charset=utf-8",
    });
  });

  it("stores an incomplete diff as stored but not complete, naming why", async () => {
    const s = store();
    const d = deps({
      store: () => s,
      readDiff: vi.fn(async () => ({
        kind: "diff" as const,
        bytes: new Uint8Array([1]),
        mergeBaseSha: null,
        files: [],
        limitations: ["files_truncated"],
      })),
    });
    await expect(captureObserved(d, REQUEST, TARGET)).resolves.toMatchObject({
      diffStatus: "stored",
      complete: false,
      limitations: ["files_truncated"],
    });
  });

  it("records a refused diff as too_large and an unreadable one as unreadable, storing nothing (negative)", async () => {
    for (const kind of ["too_large", "unreadable"] as const) {
      const s = store();
      const d = deps({
        store: () => s,
        readDiff: vi.fn(async () => ({
          kind,
          mergeBaseSha: null,
          files: [],
          limitations: [`diff_${kind}`],
        })),
      });
      await expect(captureObserved(d, REQUEST, TARGET)).resolves.toMatchObject({
        diffStatus: kind,
        diffKey: null,
      });
      expect(s.puts).toEqual([]);
    }
  });

  it("records no connection as unreadable (negative)", async () => {
    const d = deps({ store: store, readDiff: vi.fn(async () => "no_connection" as const) });
    await expect(captureObserved(d, REQUEST, TARGET)).resolves.toMatchObject({
      diffStatus: "unreadable",
      limitations: ["no_connection"],
    });
  });
});

describe("recordObserved", () => {
  it("hands the revision to the store's writer with the scope and the time", async () => {
    const d = deps();
    const capture = await captureObserved(d, REQUEST, TARGET);
    await recordObserved(d, REQUEST, "pr-1", TARGET, capture);
    expect(d.record).toHaveBeenCalledWith(SCOPE, "pr-1", TARGET, capture, NOW);
  });
});
