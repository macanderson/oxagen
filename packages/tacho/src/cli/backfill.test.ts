/**
 * `oxagen agent backfill` (#4028): its exit codes, and that neither the dry
 * run nor the progress it prints carries transcript text.
 *
 * The daemon's answer here is a real pass over the synthetic mapping
 * fixture, every text of which carries `SENTINEL-TRANSCRIPT-TEXT`, streamed
 * the way the daemon's `/backfill` route streams it.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  BackfillLedger,
  type BackfillReport,
  type BackfillRequest,
  backfillRecorders,
  runBackfill,
} from "../collector/backfill";
import { writeHostFile } from "../host/host-file";
import { agentPaths, tachoHome } from "../host/paths";
import {
  bundleSigner,
  TEST_AGENT_ID,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { sessionUuid } from "../ids";
import { BACKFILL_EXIT, backfillCommand } from "./backfill";
import { type CliDeps, defaultCliDeps } from "./deps";

const HOST = "thst_0123456789abcdef0123";
const SESSION = "0b1f0000-0000-4000-8000-00000000b001";
const FIXTURE = resolve(__dirname, "../../fixtures/claude-code/backfill/mapping");
const SENTINEL = "SENTINEL-TRANSCRIPT-TEXT";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: HOST,
  },
};

/** A pass over the fixture, as the daemon would run it for `request`. */
async function daemonPass(
  request: BackfillRequest,
  progress: (report: BackfillReport) => void,
): Promise<BackfillReport> {
  const root = mkdtempSync(join(tmpdir(), "tacho-backfill-cli-"));
  const dir = join(root, "-work-synthetic-repo");
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURE, `${SESSION}.jsonl`), join(dir, `${SESSION}.jsonl`));
  cpSync(join(FIXTURE, SESSION), join(dir, SESSION), { recursive: true });
  const old = new Date("2026-09-01T00:00:00.000Z");
  utimesSync(join(dir, `${SESSION}.jsonl`), old, old);
  let clock = Date.parse("2026-10-02T12:00:00.000Z");
  return runBackfill(request, {
    roots: [root],
    ledger: new BackfillLedger(undefined),
    // Every check sees a second gone by, so each slice reports progress.
    now: () => {
      clock += 1_000;
      return clock;
    },
    heldLocally: () => false,
    sessionUuidOf: (id) => sessionUuid(HOST, id),
    sessionHeads: async () => new Map(),
    recorder: backfillRecorders(CONTEXT, HOST),
    exclusive: async (_id, apply) => apply(),
    record: () => {},
    walTail: () => undefined,
    unshippedEvents: () => 0,
    sleep: async () => {},
    bodyMode: () => "content_exact",
    bodyShips: () => true,
    log: () => {},
    progress,
    sliceBytes: 512,
  });
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  sent: unknown[];
}

function harness(
  daemonStream: CliDeps["daemonStream"],
  enrolled = true,
): Harness {
  const home = mkdtempSync(join(tmpdir(), "tacho-backfill-home-"));
  const env = { HOME: home, TACHO_HOME: join(home, "tacho") };
  const out: string[] = [];
  const err: string[] = [];
  const sent: unknown[] = [];
  const paths = agentPaths(tachoHome(env, home, "darwin"), TEST_AGENT_ID);
  if (enrolled) {
    mkdirSync(paths.dir, { recursive: true });
    const signer = bundleSigner();
    writeHostFile(paths.hostFile, testHostFile(signer, signer.sign(unsignedBundle())));
  }
  const deps = defaultCliDeps({
    paths,
    env,
    home,
    platform: "darwin",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(daemonStream !== undefined
      ? {
          daemonStream: async (path, body, onLine) => {
            sent.push({ path, body });
            return daemonStream(path, body, onLine);
          },
        }
      : {}),
  });
  return { deps, out, err, sent };
}

/** The daemon's `/backfill` answer: progress lines, then the report. */
function streamOf(request: BackfillRequest): CliDeps["daemonStream"] {
  return async (_path, _body, onLine) => {
    const report = await daemonPass(request, (progress) =>
      onLine(JSON.stringify({ progress })),
    );
    onLine(JSON.stringify({ report }));
    return { status: 200 };
  };
}

describe("oxagen agent backfill", () => {
  it("prints counts only on a dry run, progress included", async () => {
    const { deps, out, err, sent } = harness(streamOf({ dryRun: true }));
    const code = await backfillCommand({ dryRun: true, since: "2026-08-01" }, deps);
    expect(code).toBe(BACKFILL_EXIT.finished);
    expect(sent).toEqual([
      { path: "/backfill", body: { since: "2026-08-01", dryRun: true } },
    ]);
    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("Would be backfilled: 1");
    expect(out.some((line) => line.startsWith("Progress: "))).toBe(true);
    expect(printed).not.toContain(SENTINEL);
    // No path from inside a transcript either: the fixture's cwd.
    expect(printed).not.toContain("/work/synthetic");
  });

  it("prints one JSON object with --json, and no progress", async () => {
    const { deps, out } = harness(streamOf({ dryRun: true }));
    const code = await backfillCommand({ dryRun: true, json: true }, deps);
    expect(code).toBe(BACKFILL_EXIT.finished);
    expect(out).toHaveLength(1);
    const report = JSON.parse(out[0] as string) as BackfillReport;
    expect(report.dry_run).toBe(true);
    expect(report.sessions.backfilled).toBe(1);
    expect(out[0]).not.toContain(SENTINEL);
  });

  it("prints counts only on a real pass too", async () => {
    const { deps, out, err } = harness(streamOf({}));
    expect(await backfillCommand({}, deps)).toBe(BACKFILL_EXIT.finished);
    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("Backfilled: 1");
    expect(printed).not.toContain(SENTINEL);
  });

  it("exits 2 on an invalid option and asks the daemon nothing", async () => {
    const { deps, err, sent } = harness(streamOf({}));
    expect(await backfillCommand({ since: "last week" }, deps)).toBe(
      BACKFILL_EXIT.invalid,
    );
    expect(sent).toEqual([]);
    expect(err.join("\n")).toMatch(/--since/);
  });

  it("exits 4 on a machine that is not enrolled", async () => {
    const { deps, sent } = harness(streamOf({}), false);
    expect(await backfillCommand({}, deps)).toBe(BACKFILL_EXIT.notEnrolled);
    expect(sent).toEqual([]);
  });

  it("exits 3 when no daemon answers", async () => {
    const { deps, err } = harness(async () => undefined);
    expect(await backfillCommand({}, deps)).toBe(BACKFILL_EXIT.noDaemon);
    expect(err.join("\n")).toMatch(/did not answer/);
  });

  it("exits 1 when the daemon stops before its report", async () => {
    const { deps, out, err } = harness(async (_path, _body, onLine) => {
      onLine(JSON.stringify({ progress: {} }));
      return { status: 200 };
    });
    expect(await backfillCommand({}, deps)).toBe(BACKFILL_EXIT.stopped);
    expect(err.join("\n")).toMatch(/resume/);
    // A progress line without counts, as a daemon of another build may send,
    // reads as zeros.
    expect(out).toContain("Progress: 0 sessions read, 0 backfilled, 0 frames");
  });

  it("exits 1 when the pass stopped partway", async () => {
    const { deps } = harness(async (_path, _body, onLine) => {
      const report = await daemonPass({ dryRun: true }, () => {});
      onLine(
        JSON.stringify({
          report: { ...report, finished: false, stopped: "daemon_stopping" },
        }),
      );
      return { status: 200 };
    });
    expect(await backfillCommand({}, deps)).toBe(BACKFILL_EXIT.stopped);
  });

  it("passes the daemon's refusal on, such as a pass already running", async () => {
    const { deps, err } = harness(async (_path, _body, onLine) => {
      onLine(JSON.stringify({ error: "A backfill pass is already running on this machine." }));
      return { status: 409 };
    });
    expect(await backfillCommand({}, deps)).toBe(BACKFILL_EXIT.stopped);
    expect(err.join("\n")).toMatch(/already running/);
  });
});
