/**
 * Tests for the `oxagen fleet` verbs (ADR-023 §3) — the headless surface of the
 * session fleet. Every handler runs against a real SessionStore in a throwaway
 * OXAGEN_FLEET_DIR, with the process-forking / signalling / stdin seams
 * injected, and asserts BOTH sides of the dual-mode contract: machine JSON on
 * stdout, chrome on stderr, uniform errors, exit codes.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleFleetCancel,
  handleFleetClean,
  handleFleetDispatch,
  handleFleetLogs,
  handleFleetLs,
  handleFleetRoot,
  handleFleetSend,
  handleFleetWatch,
  handleFleetWorker,
} from "../fleet.js";
import type { CommandWriter } from "../../lib/capture-writer.js";
import { fleetRoot, sessionDir } from "../../sessions/paths.js";
import { SessionStore, type SessionMeta } from "../../sessions/store.js";
import { parseSessionEventLine, type SessionEventInput } from "../../sessions/events.js";

function memoryWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

let base: string;
let projectCwd: string;
let store: SessionStore;
const savedExit = process.exitCode;
const savedEnv = process.env["OXAGEN_FLEET_DIR"];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "oxagen-fleet-cmd-"));
  process.env["OXAGEN_FLEET_DIR"] = join(base, "fleet");
  projectCwd = join(base, "project");
  store = new SessionStore({ root: fleetRoot(projectCwd) });
});

afterEach(async () => {
  process.exitCode = savedExit;
  if (savedEnv === undefined) delete process.env["OXAGEN_FLEET_DIR"];
  else process.env["OXAGEN_FLEET_DIR"] = savedEnv;
  await rm(base, { recursive: true, force: true });
});

/** Seed one session with a few events; returns its meta. */
async function seedSession(over: Partial<SessionMeta> & { sid: string }): Promise<SessionMeta> {
  const meta = await store.createSession({
    sid: over.sid,
    title: over.title ?? "seeded",
    prompt: over.prompt ?? "seeded prompt",
    owner: over.owner ?? "worker",
    pid: over.pid ?? 0,
    cwd: projectCwd,
    mode: over.mode ?? "once",
    ...(over.state !== undefined ? { state: over.state } : {}),
  });
  const writer = store.openWriter(meta);
  const events: SessionEventInput[] = [
    {
      type: "session.start",
      title: meta.title,
      prompt: meta.prompt,
      cwd: meta.cwd,
      mode: meta.mode,
      owner: meta.owner,
      pid: meta.pid,
    },
    { type: "session.state", state: "running" },
    { type: "message.end", text: "hello from the agent", turn: 1 },
  ];
  for (const e of events) writer.append(e);
  if (over.state !== undefined) writer.patchMeta({ state: over.state });
  await writer.flush();
  return meta;
}

describe("fleet ls", () => {
  it("json emits a single array on stdout; stderr stays clean", async () => {
    const { writer, out, err } = memoryWriter();
    await handleFleetLs({ json: true, cwd: projectCwd }, writer);
    expect(out).toEqual(["[]"]);
    expect(err).toEqual([]);

    await seedSession({ sid: "s-aaa-0001" });
    const second = memoryWriter();
    await handleFleetLs({ json: true, cwd: projectCwd }, second.writer);
    const parsed = JSON.parse(second.out.join("")) as Array<{ sid: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.sid).toBe("s-aaa-0001");
  });

  it("pretty renders the roster table (or the empty hint)", async () => {
    const { writer, out } = memoryWriter();
    await handleFleetLs({ cwd: projectCwd }, writer);
    expect(out.join("\n")).toContain("No sessions in this fleet");
  });
});

describe("fleet dispatch", () => {
  it("creates the session, spawns the worker, prints the sid as JSON", async () => {
    const spawns: string[][] = [];
    const { writer, out, err } = memoryWriter();
    await handleFleetDispatch(
      ["refactor", "the", "widget"],
      {
        json: true,
        cwd: projectCwd,
        spawnImpl: (_cmd, args) => {
          spawns.push(args);
          return { unref: () => undefined };
        },
      },
      writer,
    );
    const result = JSON.parse(out.join("")) as { sid: string; title: string };
    expect(result.title).toBe("refactor the widget");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.slice(-3)).toEqual(["fleet", "worker", result.sid]);
    expect((await store.readMeta(result.sid))?.owner).toBe("worker");
    expect(err).toEqual([]);
  });

  it("errors cleanly on an empty prompt with no piped stdin (usage, exit 2)", async () => {
    const { writer, out, err } = memoryWriter();
    await handleFleetDispatch(
      [],
      { json: true, cwd: projectCwd, readStdin: async () => "" },
      writer,
    );
    expect(out).toEqual([]);
    expect(JSON.parse(err.join("")) as object).toMatchObject({ type: "error" });
    expect(process.exitCode).toBe(2);
  });
});

describe("fleet send", () => {
  it("appends a message to an active session's inbox", async () => {
    const meta = await seedSession({
      sid: "s-bbb-0002",
      owner: "tui",
      pid: process.pid,
      state: "waiting",
    });
    const { writer, out } = memoryWriter();
    await handleFleetSend(meta.sid, ["please", "add", "tests"], { json: true, cwd: projectCwd }, writer);
    const inbox = await readFile(join(sessionDir(fleetRoot(projectCwd), meta.sid), "inbox.ndjson"), "utf8");
    expect(inbox).toContain('"type":"message"');
    expect(inbox).toContain("please add tests");
    expect(JSON.parse(out.join("")) as object).toMatchObject({ sid: meta.sid, ok: true });
  });

  it("refuses a terminal session with a uniform error", async () => {
    const meta = await seedSession({ sid: "s-ccc-0003", state: "done" });
    const { writer, err } = memoryWriter();
    await handleFleetSend(meta.sid, ["late"], { json: true, cwd: projectCwd }, writer);
    expect(JSON.parse(err.join("")) as object).toMatchObject({ type: "error" });
    expect(process.exitCode).toBe(1);
  });

  it("resolves short-sid references", async () => {
    const meta = await seedSession({
      sid: "s-ddd-0004",
      owner: "tui",
      pid: process.pid,
      state: "running",
    });
    const { writer } = memoryWriter();
    await handleFleetSend("0004", ["hi"], { json: true, cwd: projectCwd }, writer);
    const inbox = await readFile(join(sessionDir(fleetRoot(projectCwd), meta.sid), "inbox.ndjson"), "utf8");
    expect(inbox).toContain('"hi"');
  });
});

describe("fleet cancel", () => {
  it("appends cancel to the inbox and signals a live worker pid", async () => {
    const kills: Array<[number, string]> = [];
    const meta = await seedSession({
      sid: "s-eee-0005",
      owner: "worker",
      pid: process.pid, // "alive" for the liveness check; killImpl is injected
      state: "running",
    });
    const { writer, out } = memoryWriter();
    await handleFleetCancel(
      meta.sid,
      { json: true, cwd: projectCwd, killImpl: (pid, sig) => kills.push([pid, sig]) },
      writer,
    );
    const inbox = await readFile(join(sessionDir(fleetRoot(projectCwd), meta.sid), "inbox.ndjson"), "utf8");
    expect(inbox).toContain('"type":"cancel"');
    expect(kills).toEqual([[process.pid, "SIGTERM"]]);
    const results = JSON.parse(out.join("")) as Array<{ sid: string; cancelled: boolean }>;
    expect(results[0]).toMatchObject({ sid: meta.sid, cancelled: true });
  });

  it("--all cancels every active session and skips terminal ones", async () => {
    await seedSession({ sid: "s-fff-0006", owner: "tui", pid: process.pid, state: "running" });
    await seedSession({ sid: "s-ggg-0007", owner: "tui", pid: process.pid, state: "waiting" });
    await seedSession({ sid: "s-hhh-0008", state: "done" });
    const { writer, out } = memoryWriter();
    await handleFleetCancel(
      undefined,
      { all: true, json: true, cwd: projectCwd, killImpl: () => undefined },
      writer,
    );
    const results = JSON.parse(out.join("")) as Array<{ sid: string }>;
    expect(results.map((r) => r.sid).sort()).toEqual(["s-fff-0006", "s-ggg-0007"]);
  });

  it("no sid and no --all is a usage error", async () => {
    const { writer, err } = memoryWriter();
    await handleFleetCancel(undefined, { json: true, cwd: projectCwd }, writer);
    expect(JSON.parse(err.join("")) as object).toMatchObject({ type: "error" });
  });
});

describe("fleet logs", () => {
  it("replays the raw envelope as NDJSON and honors --from-seq", async () => {
    const meta = await seedSession({ sid: "s-iii-0009", state: "done" });
    const { writer, out } = memoryWriter();
    await handleFleetLogs(meta.sid, { json: true, cwd: projectCwd }, writer);
    const events = out.map((l) => parseSessionEventLine(l));
    expect(events.every((e) => e !== null)).toBe(true);
    expect(events.map((e) => e?.seq)).toEqual([1, 2, 3]);

    const fromTwo = memoryWriter();
    await handleFleetLogs(meta.sid, { json: true, fromSeq: "3", cwd: projectCwd }, fromTwo.writer);
    expect(fromTwo.out).toHaveLength(1);
    expect(parseSessionEventLine(fromTwo.out[0] as string)?.seq).toBe(3);
  });
});

describe("fleet clean", () => {
  it("prunes terminal sessions with --all and reports them", async () => {
    const meta = await seedSession({ sid: "s-jjj-0010", state: "done" });
    await seedSession({ sid: "s-kkk-0011", owner: "tui", pid: process.pid, state: "running" });
    const { writer, out } = memoryWriter();
    await handleFleetClean({ all: true, json: true, cwd: projectCwd }, writer);
    const result = JSON.parse(out.join("")) as { removed: string[]; count: number };
    expect(result.removed).toEqual([meta.sid]);
    expect((await store.listSessions()).map((s) => s.sid)).toEqual(["s-kkk-0011"]);
  });
});

describe("fleet watch", () => {
  it("streams live envelope events from an active session until aborted", async () => {
    const meta = await seedSession({
      sid: "s-lll-0012",
      owner: "tui",
      pid: process.pid,
      state: "running",
    });
    const { writer, out } = memoryWriter();
    const abort = new AbortController();
    const done = handleFleetWatch(
      [],
      { json: true, cwd: projectCwd, signal: abort.signal },
      writer,
    );
    // Append AFTER the watch starts — watch-all tails from each session's end.
    //
    // "After the watch starts" is not "after the watch adopted this session",
    // and only the second one is a cursor. Roster adoption reads lastSeq at
    // the moment it fires, so a single append races that read and lands on one
    // of two sides: adopted first, and the event is tailed; or appended first,
    // in which case lastSeq already counts it, adoption begins at the seq after
    // it, and it is never emitted at all. The second side cannot recover, so
    // the old single append timed out rather than ran slow — a longer deadline
    // would not have helped it.
    //
    // Appending until one is observed removes the race rather than widening
    // it: whenever adoption lands, the next append is past the cursor.
    const w = store.openWriter({ ...meta, lastSeq: 3 });
    const sawLive = (): boolean =>
      out.some((l) => l.includes('"message.delta"') && l.includes("live!"));
    const deadline = Date.now() + 10_000;
    while (!sawLive()) {
      if (Date.now() > deadline) {
        throw new Error("fleet watch never emitted an event appended after adoption");
      }
      w.append({ type: "message.delta", text: "live!", turn: 2 });
      await w.flush();
      await new Promise((r) => setTimeout(r, 50));
    }
    abort.abort();
    await done;
    expect(out.every((l) => parseSessionEventLine(l) !== null)).toBe(true);
  });
});

describe("fleet root", () => {
  it("json mode is the watch-all alias (streams, then aborts cleanly)", async () => {
    const { writer } = memoryWriter();
    const abort = new AbortController();
    const done = handleFleetRoot(
      { json: true, cwd: projectCwd, signal: abort.signal },
      writer,
    );
    abort.abort();
    await done; // resolves without touching Ink
  });

  it("refuses the REPL capture seam instead of launching Ink", async () => {
    const { writer, err } = memoryWriter();
    await handleFleetRoot({ cwd: projectCwd, stdoutIsTTY: true }, writer);
    expect(err.join(" ")).toContain("open a full terminal");
  });
});

describe("fleet worker", () => {
  it("exits 1 for an unknown session", async () => {
    const { writer, err } = memoryWriter();
    const { code } = await handleFleetWorker("s-zzz-9999", { cwd: projectCwd }, writer);
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("no session");
  });

  it("stamps its pid and returns the runner's fate", async () => {
    const meta = await seedSession({ sid: "s-mmm-0013", state: "queued" });
    const { writer } = memoryWriter();
    const { code } = await handleFleetWorker(
      meta.sid,
      {
        cwd: projectCwd,
        runSessionImpl: async ({ meta: m }) => {
          expect(m.pid).toBe(process.pid); // the worker stamped itself
          return { state: "done" as const };
        },
      },
      writer,
    );
    expect(code).toBe(0);
    expect((await store.readMeta(meta.sid))?.pid).toBe(process.pid);
  });
});
