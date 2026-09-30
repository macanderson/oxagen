import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { minimalSession } from "../../../packages/tacho/src/test-helpers";
import { boundedLines, collectBaseline, type BaselineOptions } from "./baseline";

const roots: string[] = [];
const options: BaselineOptions = { from: "2026-09-08T00:00:00Z", to: "2026-09-09T00:00:00Z", coverage: "wal-subset" };
async function snapshot(lines = minimalSession().map((event) => JSON.stringify(event))) {
  const root = await mkdtemp(join(tmpdir(), "fleet-baseline-"));
  roots.push(root);
  const path = join(root, `${minimalSession()[0]!.session_uuid}.ndjson`);
  await writeFile(path, `${lines.join("\n")}\n`);
  return { root, path };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("offline fleet baseline", () => {
  it("reports numeric hour/day rates and complete-session distributions without identifiers", async () => {
    const events = minimalSession();
    const { root } = await snapshot(events.map((event) => JSON.stringify(event)));
    const report = await collectBaseline(root, options);
    expect(report).toMatchObject({ events: 8, sessionStarts: 1, modelCalls: 2, toolCalls: 1, turnStarts: 1,
      completeSessions: 1, chainErrors: 0, malformedLines: 0,
      coverage: { declared: "wal-subset", independentlyVerified: false, representativeProducedWindow: false },
      rigBaselineDraft: { measured: false, sourceKind: "produced", samples: [{ turns: 1, weight: 1 }] } });
    expect(report.observedRates.eventsPerSecond).toBe(8 / 86400);
    expect(report.hours[10]).toMatchObject({ events: 8, eventsPerSecond: 8 / 3600 });
    expect(report.days).toHaveLength(1);
    expect(report.distributions.completeSessionEvents).toMatchObject({ count: 1, min: 8, max: 8 });
    const serialized = JSON.stringify(report);
    for (const identifier of [events[0]!.session_uuid, events[0]!.agent.agent_key, events[0]!.hash,
      events[0]!.event_id, events[0]!.event_id_idem, root]) expect(serialized).not.toContain(identifier);
    expect(report.rigBaselineDraft.samples[0]).not.toHaveProperty("bodyBytes");
  });
  it("never opens body sidecars, cursor state, or symlinked event files", async () => {
    const { root } = await snapshot();
    await writeFile(join(root, "cursor.json"), '{"secret":"do-not-read"}');
    await writeFile(join(root, "evidence.bodies.jsonl"), "do-not-read evidence");
    await symlink("missing-target", join(root, "00000000-0000-4000-8000-000000000001.ndjson"));
    const report = await collectBaseline(root, options);
    expect(report.files).toBe(1);
    expect(report.ignoredEntries).toBe(3);
    expect(JSON.stringify(report)).not.toContain("do-not-read");
    expect(report.missingMetrics.join(" ")).toContain("Body-byte distribution is unavailable");
  });
  it("keeps an operator's completeness assertion separate from verified producer coverage", async () => {
    const { root } = await snapshot();
    for (const coverage of ["operator-attested-complete", "unacknowledged-backlog", "synthetic"] as const) {
      const report = await collectBaseline(root, { ...options, coverage });
      expect(report.coverage.declared).toBe(coverage);
      expect(report.coverage.independentlyVerified).toBe(false);
      expect(report.coverage.includesAcknowledgedEvents).toBe("unknown");
      expect(report.rigBaselineDraft.measured).toBe(false);
    }
  });
  it("records malformed or broken chains without including them in complete-session samples", async () => {
    const events = minimalSession();
    const { root } = await snapshot([JSON.stringify(events[0]), "{malformed", ...events.slice(2).map((event) => JSON.stringify(event))]);
    const report = await collectBaseline(root, options);
    expect(report.malformedLines).toBe(1);
    expect(report.chainErrors).toBe(1);
    expect(report.completeSessions).toBe(0);
    expect(report.partialOrCrossBoundarySessions).toBe(1);
    expect(report.rigBaselineDraft.samples).toEqual([]);
  });
  it("excludes events at the upper time bound and refuses session-shaped duplicates under another filename", async () => {
    const { root } = await snapshot();
    const excluded = await collectBaseline(root, { ...options, to: "2026-09-08T10:06:03Z" });
    expect(excluded.events).toBe(0);
    expect(excluded.outsideWindowEvents).toBe(8);
    await writeFile(join(root, "00000000-0000-4000-8000-000000000001.ndjson"),
      `${minimalSession().map((event) => JSON.stringify(event)).join("\n")}\n`);
    const report = await collectBaseline(root, options);
    expect(report.events).toBe(8);
    expect(report.malformedLines).toBe(8);
  });
  it("marks a valid but unterminated tail as partial", async () => {
    const { root, path } = await snapshot();
    await writeFile(path, minimalSession().map((event) => JSON.stringify(event)).join("\n"));
    const report = await collectBaseline(root, options);
    expect(report.events).toBe(8);
    expect(report.unterminatedLines).toBe(1);
    expect(report.completeSessions).toBe(0);
  });
  it("bounds a line across stream chunks and enforces the total byte and window limits", async () => {
    const { root, path } = await snapshot(["x".repeat(65540)]);
    await expect(collectBaseline(root, { ...options, maxLineBytes: 65539 })).rejects.toThrow(/line-byte/);
    await expect(collectBaseline(root, { ...options, maxTotalBytes: 1024 })).rejects.toThrow(/total-byte/);
    await expect(collectBaseline(root, { ...options, to: "2026-10-01T00:00:00Z" })).rejects.toThrow(/seven days/);
    let count = 0;
    for await (const line of boundedLines(path, 65541, 65540)) {
      expect(line.bytes).toBe(65540); expect(line.terminated).toBe(true); count++;
    }
    expect(count).toBe(1);
  });
  it("computes partial-hour denominators from the requested window", async () => {
    const { root } = await snapshot();
    const report = await collectBaseline(root, { ...options, from: "2026-09-08T10:00:00Z", to: "2026-09-08T10:30:00Z" });
    expect(report.hours).toHaveLength(1);
    expect(report.hours[0]).toMatchObject({ seconds: 1800, events: 8, eventsPerSecond: 8 / 1800 });
    expect(report.days[0]).toMatchObject({ seconds: 1800, events: 8, eventsPerSecond: 8 / 1800 });
  });
  it("refuses more session files than the configured limit", async () => {
    const { root } = await snapshot();
    await writeFile(join(root, "00000000-0000-4000-8000-000000000001.ndjson"), "");
    await expect(collectBaseline(root, { ...options, maxFiles: 1 })).rejects.toThrow(/file limit/);
  });
});
