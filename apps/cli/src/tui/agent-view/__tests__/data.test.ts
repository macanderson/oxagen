/**
 * Unit tests for the `oxagen view` data layer. The pure aggregators (auth,
 * summarize, rollup, activity, formatters) are exercised directly; the IO
 * orchestrator `collectAgentViewData` runs against a REAL SessionStore on a
 * tmpdir (happy path) and against an empty store (absent-source path), with the
 * DuckDB / socket probes injected so no test touches either.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore, type SessionMetaView } from "../../../sessions/store.js";
import type { SessionEvent } from "../../../sessions/events.js";
import {
  createCodeGraphStore,
  type FileGraph,
} from "../../../daemon/code-graph/store.js";
import {
  collectAgentViewData,
  formatAge,
  formatCount,
  formatUsd,
  probeCodeGraphAt,
  recentActivity,
  resolveAuthStatus,
  rollupSessions,
  summarizeSession,
  type CodeGraphStatus,
  type DaemonStatus,
  type SessionRow,
} from "../data.js";

const metaView = (
  sid: string,
  over: Partial<SessionMetaView> = {},
): SessionMetaView =>
  ({
    v: 1,
    sid,
    title: `task ${sid}`,
    prompt: "p",
    state: "done",
    owner: "tui",
    pid: process.pid,
    cwd: "/proj",
    mode: "conversation",
    createdAt: 1_000,
    updatedAt: 2_000,
    turns: 1,
    lastSeq: 3,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    alive: false,
    derivedState: "done",
    ...over,
  }) as SessionMetaView;

describe("resolveAuthStatus", () => {
  it("reports a complete platform session", () => {
    const s = resolveAuthStatus({
      token: "t",
      orgSlug: "acme",
      workspaceSlug: "prod",
    });
    expect(s.mode).toBe("platform");
    expect(s.ok).toBe(true);
    expect(s.label).toBe("acme / prod");
  });

  it("falls back to BYOK gateway when signed out, gateway wins over anthropic", () => {
    const s = resolveAuthStatus({ gatewayKey: true, anthropicKey: true });
    expect(s.mode).toBe("byok-gateway");
    expect(s.ok).toBe(true);
  });

  it("uses anthropic BYOK when only an anthropic key is present", () => {
    const s = resolveAuthStatus({ anthropicKey: true });
    expect(s.mode).toBe("byok-anthropic");
  });

  it("forceLocal overrides an otherwise-complete platform login", () => {
    const s = resolveAuthStatus({
      token: "t",
      orgSlug: "acme",
      workspaceSlug: "prod",
      gatewayKey: true,
      forceLocal: true,
    });
    expect(s.mode).toBe("byok-gateway");
    expect(s.label).toContain("forced");
  });

  it("is signed-out with no session and no key", () => {
    const s = resolveAuthStatus({});
    expect(s.mode).toBe("none");
    expect(s.ok).toBe(false);
  });
});

describe("summarizeSession", () => {
  it("counts a live run's duration to now, a finished run's to its end", () => {
    const now = 10_000;
    const live = summarizeSession(
      metaView("s-1", {
        state: "running",
        derivedState: "running",
        createdAt: 5_000,
      }),
      now,
    );
    expect(live.live).toBe(true);
    expect(live.durationMs).toBe(5_000); // now - createdAt

    const done = summarizeSession(
      metaView("s-2", { createdAt: 1_000, updatedAt: 2_500, endedAt: 2_500 }),
      now,
    );
    expect(done.live).toBe(false);
    expect(done.durationMs).toBe(1_500); // endedAt - createdAt, ignores now
  });

  it("carries model/agent through only when present", () => {
    const withModel = summarizeSession(
      metaView("s-3", { model: "haiku", agent: "code" }),
      3_000,
    );
    expect(withModel.model).toBe("haiku");
    expect(withModel.agent).toBe("code");
    const without = summarizeSession(metaView("s-4"), 3_000);
    expect(without.model).toBeUndefined();
  });
});

describe("rollupSessions", () => {
  const row = (over: Partial<SessionRow>): SessionRow => ({
    sid: "s",
    title: "t",
    state: "done",
    live: false,
    owner: "tui",
    turns: 1,
    startedAt: 1_000,
    durationMs: 100,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
    updatedAt: 2_000,
    ...over,
  });

  it("splits fleet vs repl, counts active, sums tokens and spend", () => {
    const now = Date.now();
    const rows = [
      row({ sid: "a", owner: "worker", state: "done" }),
      row({ sid: "b", owner: "tui", state: "running", live: true }),
      row({ sid: "c", owner: "worker", state: "failed" }),
    ];
    const r = rollupSessions(rows, now);
    expect(r.total).toBe(3);
    expect(r.fleetRuns).toBe(2);
    expect(r.interactiveRuns).toBe(1);
    expect(r.active).toBe(1);
    expect(r.byState.done).toBe(1);
    expect(r.byState.failed).toBe(1);
    expect(r.byState.running).toBe(1);
    expect(r.inputTokens).toBe(30);
    expect(r.costUsdTotal).toBeCloseTo(1.5);
  });

  it("only counts today's spend for runs started since local midnight", () => {
    const now = Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const yesterday = todayStart.getTime() - 60_000;
    const rows = [
      row({
        sid: "old",
        startedAt: yesterday,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 2 },
      }),
      row({
        sid: "new",
        startedAt: now,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 3 },
      }),
    ];
    const r = rollupSessions(rows, now);
    expect(r.costUsdTotal).toBeCloseTo(5);
    expect(r.costUsdToday).toBeCloseTo(3);
  });

  it("is zero across the board for no runs", () => {
    const r = rollupSessions([], Date.now());
    expect(r.total).toBe(0);
    expect(r.active).toBe(0);
    expect(r.costUsdTotal).toBe(0);
    expect(r.lastActivityAt).toBeNull();
  });
});

describe("recentActivity", () => {
  const ev = (seq: number, partial: object): SessionEvent =>
    ({ v: 1, sid: "s-1", seq, ts: seq * 1000, ...partial }) as SessionEvent;

  it("keeps only salient lines, capped to the limit, newest kept", () => {
    const events = [
      ev(1, {
        type: "session.start",
        title: "fix bug",
        prompt: "p",
        cwd: "/",
        mode: "once",
        owner: "tui",
        pid: 1,
      }),
      ev(2, { type: "reasoning.delta", text: "thinking", turn: 1 }), // dropped (not salient)
      ev(3, { type: "tool.end", name: "bash", ok: true, durationMs: 100 }),
      ev(4, { type: "message.end", text: "Done.", turn: 1 }),
    ];
    const lines = recentActivity(events, 2);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.text.includes("thinking"))).toBe(false);
    expect(lines[lines.length - 1]?.text).toContain("Done.");
  });
});

describe("formatters", () => {
  it("formatCount abbreviates thousands and millions", () => {
    expect(formatCount(42)).toBe("42");
    expect(formatCount(1_500)).toBe("1.5k");
    expect(formatCount(2_500_000)).toBe("2.5M");
  });

  it("formatUsd matches the canonical engine formatter (no drift)", () => {
    // Re-exported from agent/model-router (the engine rate-card formatter) so
    // this dashboard renders costs identically to every other repl/tui panel.
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00004)).toBe("<$0.0001");
    expect(formatUsd(0.42)).toBe("$0.4200");
    expect(formatUsd(1500)).toBe("$1500.00");
  });

  it("formatAge renders coarse relative time", () => {
    const now = 1_000_000_000;
    expect(formatAge(now, now)).toBe("just now");
    expect(formatAge(now - 30_000, now)).toBe("30s ago");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("collectAgentViewData", () => {
  let root: string;
  let store: SessionStore;

  const codeGraphReady: CodeGraphStatus = {
    state: "ready",
    dbPath: "/x.duckdb",
    root: "/proj",
    files: 120,
    symbols: 900,
    edges: 1500,
    embeddedFiles: 100,
    lastIndexedAt: 1234,
  };
  const daemonUp: DaemonStatus = {
    running: true,
    socketPath: "/x.sock",
    pid: 42,
    uptimeSeconds: 60,
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "oxagen-view-"));
    store = new SessionStore({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("happy path: aggregates real recorded runs, activity, and passes probes through", async () => {
    const now = Date.now();
    // A finished fleet run with recorded cost.
    const done = await store.createSession({
      sid: "s-done-aaaa",
      title: "ship the audit view",
      prompt: "p",
      owner: "worker",
      pid: process.pid,
      cwd: root,
      mode: "once",
      model: "fable-5",
      state: "done",
    });
    const w = store.openWriter(done);
    w.append({
      type: "session.start",
      title: "ship the audit view",
      prompt: "p",
      cwd: root,
      mode: "once",
      owner: "worker",
      pid: process.pid,
    });
    w.append({ type: "message.end", text: "Shipped it.", turn: 1 });
    w.patchMeta({
      state: "done",
      turns: 1,
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.25 },
    });
    await w.flush();

    const data = await collectAgentViewData({
      cwd: root,
      now,
      store,
      auth: resolveAuthStatus({
        token: "t",
        orgSlug: "acme",
        workspaceSlug: "prod",
      }),
      probeCodeGraph: async () => codeGraphReady,
      probeDaemon: async () => daemonUp,
    });

    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.title).toBe("ship the audit view");
    expect(data.rows[0]?.owner).toBe("worker");
    expect(data.rollup.total).toBe(1);
    expect(data.rollup.fleetRuns).toBe(1);
    expect(data.rollup.costUsdTotal).toBeCloseTo(0.25);
    expect(data.activity.some((l) => l.text.includes("Shipped it."))).toBe(
      true,
    );
    expect(data.codeGraph).toEqual(codeGraphReady);
    expect(data.daemon).toEqual(daemonUp);
    expect(data.auth.mode).toBe("platform");
    expect(data.sourceError).toBeUndefined();
  });

  it("absent-source path: empty store yields real zeros and empty panels", async () => {
    const data = await collectAgentViewData({
      cwd: root,
      store,
      auth: resolveAuthStatus({}),
      probeCodeGraph: async () => ({ state: "absent", dbPath: "/x.duckdb" }),
      probeDaemon: async () => ({ running: false, socketPath: "/x.sock" }),
    });

    expect(data.rows).toEqual([]);
    expect(data.rollup.total).toBe(0);
    expect(data.rollup.lastActivityAt).toBeNull();
    expect(data.activity).toEqual([]);
    expect(data.codeGraph.state).toBe("absent");
    expect(data.daemon.running).toBe(false);
    expect(data.auth.ok).toBe(false);
  });
});

describe("probeCodeGraphAt (real DuckDB read path)", () => {
  let repo: string;
  let dbDir: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "oxagen-cg-probe-"));
    dbDir = await mkdtemp(join(tmpdir(), "oxagen-cg-db-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it("reports absent when the file does not exist", async () => {
    const status = await probeCodeGraphAt(join(dbDir, "nope.duckdb"), repo);
    expect(status.state).toBe("absent");
  });

  it("reads real files/symbols/edges/embedding from a populated store", async () => {
    const dbPath = join(dbDir, "code-graph.duckdb");
    const store = createCodeGraphStore({ duckdbPath: dbPath });
    // A file node (with a persisted embedding) + a symbol + a containment edge.
    const graph: FileGraph = {
      contentHash: "h1",
      nodes: [
        {
          id: "f1",
          kind: "file",
          name: "a.ts",
          path: "a.ts",
          range: { start: 1, end: 9 },
          language: "ts",
          embedding: [0.1, 0.2, 0.3],
          embeddingProvider: "local-hash-v1",
        },
        {
          id: "s1",
          kind: "function",
          name: "foo",
          path: "a.ts",
          range: { start: 1, end: 3 },
          language: "ts",
        },
      ],
      edges: [{ source: "f1", target: "s1", type: "contains" }],
    };
    await store.replaceFile(repo, "a.ts", graph);
    await store.close();

    const status = await probeCodeGraphAt(dbPath, repo);
    expect(status.state).toBe("ready");
    if (status.state === "ready") {
      expect(status.files).toBe(1);
      expect(status.symbols).toBe(1);
      expect(status.edges).toBe(1);
      expect(status.embeddedFiles).toBe(1);
      expect(status.root).toBe(repo);
      expect(status.lastIndexedAt).not.toBeNull();
    }
  });

  it("reports empty when the store has no rows for this repo", async () => {
    const dbPath = join(dbDir, "code-graph.duckdb");
    const store = createCodeGraphStore({ duckdbPath: dbPath });
    await store.replaceFile("/some/other/repo", "x.ts", {
      contentHash: "h",
      nodes: [
        {
          id: "f9",
          kind: "file",
          name: "x.ts",
          path: "x.ts",
          range: { start: 1, end: 2 },
          language: "ts",
        },
      ],
      edges: [],
    });
    await store.close();

    const status = await probeCodeGraphAt(dbPath, repo);
    expect(status.state).toBe("empty");
  });
});
