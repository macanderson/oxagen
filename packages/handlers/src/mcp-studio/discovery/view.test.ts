// view.test.ts: a discovery row as Studio reads it (lane M10, #4682). Each
// case checks one field of discoveryView, or one clock isStalled reads.
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryRow } from "./store";

// entry.ts, which holds STALLED_MS, builds the event client when it loads.
vi.mock("../../event-client", () => ({ eventClient: { send: vi.fn() } }));

import { STALLED_MS } from "./entry";
import { discoveryView, isStalled } from "./view";

const NOW = new Date("2026-09-28T15:00:12Z");
/** One minute past the stall line. */
const OLD = new Date(NOW.getTime() - STALLED_MS - 60_000);
/** One minute inside the stall line. */
const FRESH = new Date(NOW.getTime() - STALLED_MS + 60_000);

function row(overrides: Partial<DiscoveryRow> = {}): DiscoveryRow {
  return {
    id: "0191d0a0-0000-7000-8000-00000000d15c",
    server: "stripe",
    mcpServerId: null,
    status: "queued",
    trigger: "manual",
    requestedAt: NOW,
    requestedBy: "user_1",
    startedAt: null,
    finishedAt: null,
    error: null,
    outcome: null,
    toolCount: null,
    machine: null,
    sourceKind: null,
    sourceRepo: null,
    sourcePath: null,
    sourceRef: null,
    schedule: null,
    upstreamDigest: null,
    latestVersion: null,
    pr: null,
    withheld: [],
    ...overrides,
  };
}

describe("isStalled", () => {
  it("reads a queued row by requestedAt", () => {
    expect(isStalled(row({ status: "queued", requestedAt: OLD }), NOW)).toBe(true);
    expect(isStalled(row({ status: "queued", requestedAt: FRESH }), NOW)).toBe(false);
  });

  it("ignores an older run's startedAt on a queued row", () => {
    const requeued = row({ status: "queued", requestedAt: FRESH, startedAt: OLD });
    expect(isStalled(requeued, NOW)).toBe(false);
  });

  it("reads a running row by startedAt", () => {
    expect(
      isStalled(row({ status: "running", requestedAt: OLD, startedAt: OLD }), NOW),
    ).toBe(true);
    expect(
      isStalled(row({ status: "running", requestedAt: OLD, startedAt: FRESH }), NOW),
    ).toBe(false);
  });

  it("reads a running row by requestedAt before the run records startedAt", () => {
    expect(
      isStalled(row({ status: "running", requestedAt: OLD, startedAt: null }), NOW),
    ).toBe(true);
    expect(
      isStalled(row({ status: "running", requestedAt: FRESH, startedAt: null }), NOW),
    ).toBe(false);
  });

  it("never marks a finished row stalled", () => {
    for (const status of ["succeeded", "failed"] as const) {
      const done = row({ status, requestedAt: OLD, startedAt: OLD, finishedAt: OLD });
      expect(isStalled(done, NOW)).toBe(false);
    }
  });
});

describe("discoveryView", () => {
  it("writes every date as an ISO string and keeps each null", () => {
    const view = discoveryView(row(), NOW);
    expect(view).toEqual({
      id: "0191d0a0-0000-7000-8000-00000000d15c",
      server: "stripe",
      mcpServerId: null,
      status: "queued",
      trigger: "manual",
      requestedAt: "2026-09-28T15:00:12.000Z",
      requestedBy: "user_1",
      startedAt: null,
      finishedAt: null,
      error: null,
      outcome: null,
      toolCount: null,
      machine: null,
      sourceKind: null,
      sourceRepo: null,
      sourcePath: null,
      sourceRef: null,
      schedule: null,
      upstreamDigest: null,
      latestVersion: null,
      pr: null,
      withheld: [],
      stalled: false,
    });
  });

  it("copies a finished run's fields and marks it not stalled", () => {
    const pr = {
      number: 41,
      url: "https://github.com/a-intel/steering/pull/41",
      branch: "tools/sync-stripe-20260928t150012",
    };
    const finished = row({
      mcpServerId: "mcs_1",
      status: "succeeded",
      trigger: "schedule",
      requestedAt: OLD,
      requestedBy: null,
      startedAt: OLD,
      finishedAt: NOW,
      outcome: "pr_opened",
      toolCount: 3,
      sourceKind: "remote",
      schedule: "daily",
      upstreamDigest: `sha256:${"a".repeat(64)}`,
      latestVersion: "2026.09.1",
      pr,
      withheld: ["create_customer"],
    });
    const view = discoveryView(finished, NOW);
    expect(view).toMatchObject({
      mcpServerId: "mcs_1",
      status: "succeeded",
      requestedAt: OLD.toISOString(),
      requestedBy: null,
      startedAt: OLD.toISOString(),
      finishedAt: NOW.toISOString(),
      outcome: "pr_opened",
      toolCount: 3,
      sourceKind: "remote",
      schedule: "daily",
      latestVersion: "2026.09.1",
      pr,
      withheld: ["create_customer"],
      stalled: false,
    });
  });

  it("marks a running row stalled past the line", () => {
    const view = discoveryView(row({ status: "running", startedAt: OLD }), NOW);
    expect(view.stalled).toBe(true);
    expect(view.startedAt).toBe(OLD.toISOString());
  });

  it("returns a copy of withheld, so the view never aliases the row", () => {
    const source = row({ withheld: ["create_refund"] });
    const view = discoveryView(source, NOW);
    source.withheld.push("list_charges");
    expect(view.withheld).toEqual(["create_refund"]);
  });
});
