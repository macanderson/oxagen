/**
 * A backfill pass inside the daemon (#4028, ADR-161): which transcripts it
 * reads, which it leaves, and how an interrupted pass resumes.
 *
 * The WAL here is a map of chains that refuses an event out of seq order, as
 * the real one does, so a pass that appended a frame twice fails the test.
 */
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { sessionUuid } from "../ids";
import {
  BackfillLedger,
  type BackfillDeps,
  type BackfillReport,
  backfillRecorders,
  parseBackfillRequest,
  runBackfill,
  type ServerSessionHead,
} from "./backfill";

const HOST = "thst_0123456789abcdef0123";
const SESSION = "0b1f0000-0000-4000-8000-00000000b001";
const PROJECT = "-work-synthetic-repo";
const FIXTURE = resolve(
  __dirname,
  "../../fixtures/claude-code/backfill/mapping",
);
const SENTINEL = "SENTINEL-TRANSCRIPT-TEXT";
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const OLD = new Date("2026-09-01T00:00:00.000Z");

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: HOST,
  },
  now: () => {
    throw new Error("a backfill must not read the wall clock");
  },
};

/** A WAL that keeps each chain in memory and refuses a gap or a repeat. */
class FakeWal {
  readonly chains = new Map<string, TachoEvent[]>();
  readonly bodies: FrameBody[] = [];
  appends = 0;
  append(events: readonly TachoEvent[], bodies: readonly FrameBody[]): void {
    for (const event of events) {
      const chain = this.chains.get(event.session_uuid) ?? [];
      if (event.seq !== chain.length)
        throw new Error(
          `seq ${event.seq} after ${chain.length - 1} on ${event.session_uuid}`,
        );
      chain.push(event);
      this.chains.set(event.session_uuid, chain);
    }
    this.bodies.push(...bodies);
    this.appends += 1;
  }
  tail(uuid: string): { seq: number; prevHash: string } | undefined {
    const last = this.chains.get(uuid)?.at(-1);
    return last === undefined
      ? undefined
      : { seq: last.seq + 1, prevHash: last.hash };
  }
  all(): TachoEvent[] {
    return [...this.chains.values()].flat();
  }
}

/** A projects folder holding the mapping fixture, last written long ago. */
function projectsRoot(): { root: string; transcript: string } {
  const root = mkdtempSync(join(tmpdir(), "tacho-backfill-"));
  const dir = join(root, PROJECT);
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURE, `${SESSION}.jsonl`), join(dir, `${SESSION}.jsonl`));
  cpSync(join(FIXTURE, SESSION), join(dir, SESSION), { recursive: true });
  const transcript = join(dir, `${SESSION}.jsonl`);
  utimesSync(transcript, OLD, OLD);
  return { root, transcript };
}

function deps(
  root: string,
  wal: FakeWal,
  overrides: Partial<BackfillDeps> = {},
): BackfillDeps {
  return {
    roots: [root],
    ledger: new BackfillLedger(join(root, "..", `cursor-${process.pid}-${Math.random()}.json`)),
    now: () => NOW,
    heldLocally: () => false,
    sessionUuidOf: (id) => sessionUuid(HOST, id),
    sessionHeads: async () => new Map(),
    recorder: backfillRecorders(CONTEXT, HOST),
    exclusive: async (_id, apply) => apply(),
    record: (events, bodies) => wal.append(events, bodies),
    walTail: (uuid) => wal.tail(uuid),
    unshippedEvents: () => 0,
    sleep: async () => {},
    bodyMode: () => "content_exact",
    bodyShips: () => true,
    log: () => {},
    ...overrides,
  };
}

function dense(wal: FakeWal): void {
  for (const chain of wal.chains.values()) {
    expect(chain.map((event) => event.seq)).toEqual(chain.map((_, i) => i));
    expect(verifyChain(chain, { expectGenesis: true }).ok).toBe(true);
  }
}

describe("a backfill pass", () => {
  it("backfills a session nothing holds, and every frame reaches the WAL once", async () => {
    const { root, transcript } = projectsRoot();
    const wal = new FakeWal();
    const run = deps(root, wal);
    const report = await runBackfill({}, run);
    expect(report.finished).toBe(true);
    expect(report.sessions.backfilled).toBe(1);
    // The session, its spawned subagent, and the one no call names.
    expect(wal.chains.size).toBe(3);
    dense(wal);
    const root0 = wal.chains.get(sessionUuid(HOST, SESSION)) ?? [];
    expect(root0.at(-1)?.kind).toBe("agent_stop");
    expect(report.projects).toEqual([
      {
        slug: PROJECT,
        sessions: 1,
        subagents: 2,
        first: "2026-08-10",
        last: "2026-08-10",
        included: true,
      },
    ]);
    // The cursor file now places the chain and the read position, for a
    // live resume.
    const head = run.ledger.chainHead(sessionUuid(HOST, SESSION));
    expect(head?.cursor.seq).toBe(root0.length);
    expect(head?.cursor.prevHash).toBe(root0.at(-1)?.hash);
    expect(head?.turnSeq).toBe(3);
    const cursor = run.ledger.transcriptCursor(SESSION, transcript);
    expect(cursor?.offset).toBe(readFileSync(transcript).length);
    expect(cursor?.subagents).toEqual(["orph0001", "sub0001"]);
    expect(run.ledger.transcriptCursor("another-session", transcript)).toBeUndefined();
  });

  it("seals byte-identical frames on two hosts with the same scope", async () => {
    const first = new FakeWal();
    const second = new FakeWal();
    await runBackfill({}, deps(projectsRoot().root, first));
    await runBackfill({}, deps(projectsRoot().root, second));
    expect(JSON.stringify(second.all())).toBe(JSON.stringify(first.all()));
  });

  it("skips on a second pass what the first sealed", async () => {
    const { root } = projectsRoot();
    const wal = new FakeWal();
    const run = deps(root, wal);
    await runBackfill({}, run);
    const before = wal.all().length;
    const report = await runBackfill({}, run);
    expect(report.sessions.skipped_already_backfilled).toBe(1);
    expect(report.sessions.backfilled).toBe(0);
    expect(wal.all()).toHaveLength(before);
  });

  it("on a host whose TACHO_HOME was wiped, skips what the control plane holds and sends nothing at seq 0", async () => {
    const { root } = projectsRoot();
    for (const [head, action] of [
      [
        { record_basis: "backfill", backfill_normalizer: "1" },
        "skipped_already_backfilled",
      ],
      [
        { record_basis: "backfill", backfill_normalizer: "0" },
        "skipped_older_normalizer",
      ],
      [{ record_basis: "live", backfill_normalizer: null }, "skipped_server_chain"],
      [{ record_basis: "mixed", backfill_normalizer: null }, "skipped_server_chain"],
    ] as const) {
      // No cursor file and an empty WAL: nothing on this host says the
      // session was ever recorded.
      const wal = new FakeWal();
      const asked: Array<Array<{ sessionUuid: string; sessionId: string }>> =
        [];
      const report = await runBackfill(
        {},
        deps(root, wal, {
          sessionHeads: async (uuids) => {
            asked.push([...uuids]);
            const server: ServerSessionHead = {
              session_uuid: sessionUuid(HOST, SESSION),
              seq_count: 40,
              ...head,
            };
            return new Map([[server.session_uuid, server]]);
          },
        }),
      );
      expect(asked).toEqual([
        [{ sessionUuid: sessionUuid(HOST, SESSION), sessionId: SESSION }],
      ]);
      expect(report.sessions[action]).toBe(1);
      expect(report.sessions.backfilled).toBe(0);
      expect(wal.appends).toBe(0);
    }
  });

  it("seals nothing when the control plane does not answer, and a dry run still counts", async () => {
    const { root } = projectsRoot();
    const wal = new FakeWal();
    const report = await runBackfill(
      {},
      deps(root, wal, { sessionHeads: async () => undefined }),
    );
    expect(report.sessions.skipped_server_unanswered).toBe(1);
    expect(wal.appends).toBe(0);
    const dry = await runBackfill(
      { dryRun: true },
      deps(root, wal, { sessionHeads: async () => undefined }),
    );
    expect(dry.dry_run).toBe(true);
    expect(dry.sessions.skipped_server_unanswered).toBe(1);
    expect(dry.frames["llm_call"]).toBeGreaterThan(0);
    expect(wal.appends).toBe(0);
  });

  it("writes nothing on a dry run, and reports what it would send", async () => {
    const { root } = projectsRoot();
    const wal = new FakeWal();
    const run = deps(root, wal);
    const report = await runBackfill({ dryRun: true }, run);
    expect(report.sessions.backfilled).toBe(1);
    expect(report.frames["agent_start"]).toBe(3);
    expect(report.bodies.shipped).toBeGreaterThan(0);
    expect(wal.appends).toBe(0);
    expect(run.ledger.chainHead(sessionUuid(HOST, SESSION))).toBeUndefined();
  });

  it("leaves a session the daemon holds to the live path", async () => {
    const { root } = projectsRoot();
    const wal = new FakeWal();
    const report = await runBackfill(
      {},
      deps(root, wal, { heldLocally: (id) => id === SESSION }),
    );
    expect(report.sessions.skipped_local_chain).toBe(1);
    expect(wal.appends).toBe(0);
  });

  it("leaves a transcript written in the last 15 minutes", async () => {
    const { root, transcript } = projectsRoot();
    const recent = new Date(NOW - 60_000);
    utimesSync(transcript, recent, recent);
    const wal = new FakeWal();
    const report = await runBackfill({}, deps(root, wal));
    expect(report.sessions.skipped_active).toBe(1);
    expect(wal.appends).toBe(0);
  });

  it("filters by date, project, and session", async () => {
    const { root } = projectsRoot();
    const count = async (request: Parameters<typeof runBackfill>[0]) =>
      (await runBackfill(request, deps(root, new FakeWal(), {})))
        .sessions.backfilled;
    expect(await count({ since: "2026-08-10" })).toBe(1);
    expect(await count({ since: "2026-08-11" })).toBe(0);
    expect(await count({ until: "2026-08-10" })).toBe(0);
    expect(await count({ until: "2026-08-11" })).toBe(1);
    expect(await count({ projects: ["-another"] })).toBe(0);
    expect(await count({ excludeProjects: [PROJECT] })).toBe(0);
    expect(await count({ sessions: ["another-session"] })).toBe(0);
    expect(await count({ sessions: [SESSION] })).toBe(1);
  });

  it("resumes an interrupted pass into one chain with no repeated seq", async () => {
    const whole = new FakeWal();
    await runBackfill({}, deps(projectsRoot().root, whole));

    const { root } = projectsRoot();
    const wal = new FakeWal();
    const stop = new AbortController();
    const ledgerPath = join(root, "..", `resume-${Math.random()}.json`);
    const first = await runBackfill(
      {},
      deps(root, wal, {
        ledger: new BackfillLedger(ledgerPath),
        sliceBytes: 512,
        record: (events, bodies) => {
          wal.append(events, bodies);
          // The daemon stops after the first slice lands.
          stop.abort("daemon_stopping");
        },
        signal: stop.signal,
      }),
    );
    expect(first.finished).toBe(false);
    expect(first.stopped).toBe("daemon_stopping");
    const partway = wal.all().length;
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(whole.all().length);

    // A new daemon reads the cursor file from disk and resumes.
    const second = await runBackfill(
      {},
      deps(root, wal, {
        ledger: new BackfillLedger(ledgerPath),
        sliceBytes: 512,
      }),
    );
    expect(second.finished).toBe(true);
    expect(second.sessions.backfilled).toBe(1);
    dense(wal);
    expect(JSON.stringify(wal.all().sort(bySessionThenSeq))).toBe(
      JSON.stringify(whole.all().sort(bySessionThenSeq)),
    );
  });

  it("leaves a torn final line unread until a later pass finds it whole", async () => {
    const { root, transcript } = projectsRoot();
    const line = JSON.stringify({
      type: "user",
      uuid: "u-torn",
      timestamp: "2026-08-10T10:00:30.000Z",
      sessionId: SESSION,
      cwd: "/work/synthetic-repo",
      promptId: "p-torn",
      message: { role: "user", content: `Synthetic torn prompt ${SENTINEL}` },
    });
    appendFileSync(transcript, line.slice(0, 40));
    utimesSync(transcript, OLD, OLD);
    const wal = new FakeWal();
    const ledgerPath = join(root, "..", `torn-${Math.random()}.json`);
    const first = await runBackfill(
      {},
      deps(root, wal, { ledger: new BackfillLedger(ledgerPath) }),
    );
    expect(first.errors.torn_tails).toBe(1);
    const parent = () => wal.chains.get(sessionUuid(HOST, SESSION)) ?? [];
    // The session stays open: the line may still be written.
    expect(parent().some((event) => event.kind === "agent_stop")).toBe(false);
    const turnsBefore = parent().filter((e) => e.kind === "turn_start").length;

    appendFileSync(transcript, `${line.slice(40)}\n`);
    utimesSync(transcript, OLD, OLD);
    const second = await runBackfill(
      {},
      deps(root, wal, { ledger: new BackfillLedger(ledgerPath) }),
    );
    expect(second.errors.torn_tails).toBe(0);
    dense(wal);
    expect(parent().filter((e) => e.kind === "turn_start")).toHaveLength(
      turnsBefore + 1,
    );
    expect(parent().at(-1)?.kind).toBe("agent_stop");
  });

  it("counts and goes past a line too long to read", async () => {
    const { root, transcript } = projectsRoot();
    const lines = readFileSync(transcript, "utf8").split("\n");
    // 17 MiB of one line, past the 16 MiB a pass reads.
    lines.splice(5, 0, `{"type":"user","pad":"${"x".repeat(17 * 1024 * 1024)}"}`);
    writeFileSync(transcript, lines.join("\n"));
    utimesSync(transcript, OLD, OLD);
    const wal = new FakeWal();
    const report = await runBackfill({}, deps(root, wal));
    expect(report.errors.long_lines).toBe(1);
    expect(report.sessions.backfilled).toBe(1);
    const gaps = wal.all().filter((e) => e.kind === "telemetry_gap");
    expect(gaps.map((e) => e.attrs["gap.reason"])).toContain(
      "transcript_line_too_long",
    );
    dense(wal);
  });

  it("refuses a resume whose WAL holds a different chain, and marks it failed for good", async () => {
    const { root } = projectsRoot();
    const wal = new FakeWal();
    const ledgerPath = join(root, "..", `diverged-${Math.random()}.json`);
    const stop = new AbortController();
    await runBackfill(
      {},
      deps(root, wal, {
        ledger: new BackfillLedger(ledgerPath),
        sliceBytes: 512,
        record: (events, bodies) => {
          wal.append(events, bodies);
          stop.abort("daemon_stopping");
        },
        signal: stop.signal,
      }),
    );
    // Something else rewrote the chain's last frame.
    const chain = wal.chains.get(sessionUuid(HOST, SESSION)) ?? [];
    const last = chain.at(-1) as TachoEvent;
    chain[chain.length - 1] = { ...last, hash: `sha256:${"0".repeat(64)}` };
    const before = wal.all().length;
    const second = await runBackfill(
      {},
      deps(root, wal, { ledger: new BackfillLedger(ledgerPath) }),
    );
    expect(second.sessions.failed).toBe(1);
    expect(wal.all()).toHaveLength(before);
    const third = await runBackfill(
      {},
      deps(root, wal, { ledger: new BackfillLedger(ledgerPath) }),
    );
    expect(third.sessions.failed).toBe(1);
    expect(wal.all()).toHaveLength(before);
  });

  it("reports counts only: no transcript text reaches the report", async () => {
    const { root } = projectsRoot();
    const progress: BackfillReport[] = [];
    let clock = NOW;
    const report = await runBackfill(
      { dryRun: true },
      deps(root, new FakeWal(), {
        // Every check sees a second gone by, so progress reports go out.
        now: () => {
          clock += 1_000;
          return clock;
        },
        progress: (p) => progress.push(p),
        sliceBytes: 512,
      }),
    );
    expect(progress.length).toBeGreaterThan(0);
    for (const value of [report, ...progress])
      expect(JSON.stringify(value)).not.toContain(SENTINEL);
  });
});

describe("parseBackfillRequest", () => {
  it("takes the options the command sends", () => {
    expect(
      parseBackfillRequest({
        since: "2026-08-01",
        until: "2026-09-01",
        projects: ["-a"],
        excludeProjects: ["-b"],
        sessions: ["0b1f0000-0000-4000-8000-00000000b001"],
        dryRun: true,
      }),
    ).toEqual({
      request: {
        since: "2026-08-01",
        until: "2026-09-01",
        projects: ["-a"],
        excludeProjects: ["-b"],
        sessions: ["0b1f0000-0000-4000-8000-00000000b001"],
        dryRun: true,
      },
    });
  });

  it.each([
    [{ since: "08/01/2026" }],
    [{ since: "2026-09-01", until: "2026-08-01" }],
    [{ projects: ["../outside"] }],
    [{ projects: ["a/b"] }],
    [{ excludeProjects: [".."] }],
    [{ sessions: ["../../etc"] }],
    [{ dryRun: "yes" }],
    [[]],
  ])("refuses %j", (input) => {
    expect("error" in parseBackfillRequest(input)).toBe(true);
  });
});

function bySessionThenSeq(a: TachoEvent, b: TachoEvent): number {
  return a.session_uuid === b.session_uuid
    ? a.seq - b.seq
    : a.session_uuid.localeCompare(b.session_uuid);
}
