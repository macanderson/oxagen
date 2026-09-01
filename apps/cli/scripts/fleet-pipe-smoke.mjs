#!/usr/bin/env node
/**
 * Fleet pipe smoke test (ADR-023) — proves the headless NDJSON "pipe story"
 * end-to-end: a process seeds an agent session and a *separate* process reads
 * the session's event log / roster and parses it as the envelope wire format,
 * exactly as `jq` or a downstream agent would.
 *
 * The script is self-contained (only `node:` builtins). Anything that touches
 * TypeScript source is run through a spawned `node --import tsx` child, so this
 * file needs no build step and no dependencies of its own.
 *
 * Three legs, each independently pass/skip/fail:
 *
 *   A. store-level (ALWAYS runs, MUST pass today) — seeds a session through the
 *      committed store (sessions/store.ts) into a throwaway OXAGEN_FLEET_DIR,
 *      then validates the on-disk NDJSON + roster from the OUTSIDE as an
 *      external consumer (structural envelope check + monotonic seq), and tails
 *      it live in a spawned child that we kill once the seeded events arrive.
 *
 *   B. cli-subprocess — the real `oxagen fleet ls|logs|watch --json` pipe
 *      against the wired `commands/fleet.ts` command tree.
 *
 *   C. live-dispatch (gated behind OXAGEN_SMOKE_LIVE=1) — `oxagen fleet dispatch`
 *      → a real detached worker → follow to its fate.
 *
 * Usage:
 *   node scripts/fleet-pipe-smoke.mjs            # legs A (+ B if wired)
 *   OXAGEN_SMOKE_LIVE=1 node scripts/…           # also attempt the live leg
 *   OXAGEN_SMOKE_OUT=/path/transcript.txt node … # also save the transcript
 *
 * Exit: 0 if nothing FAILED (skips are not failures), 1 otherwise.
 * All human-readable output goes to stderr; stdout is left clean on purpose.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const SCRIPT = fileURLToPath(import.meta.url);
const CLI_ROOT = dirname(dirname(SCRIPT)); // apps/cli
const SRC = join(CLI_ROOT, "src", "sessions");
const CLI_ENTRY = join(CLI_ROOT, "src", "index.ts");
const STORE_TS = join(SRC, "store.ts");
const PATHS_TS = join(SRC, "paths.ts");
const IDS_TS = join(SRC, "ids.ts");

const SENTINEL = "__SMOKE__";

// ---------------------------------------------------------------------------
// Reporting — everything to stderr, mirrored into a transcript.
// ---------------------------------------------------------------------------

const transcript = [];
let failures = 0;

function say(line) {
  transcript.push(line);
  process.stderr.write(line + "\n");
}
const info = (msg) => say("   · " + msg);
const pass = (msg) => say(" ✓ PASS  " + msg);
const skip = (msg) => say(" ○ SKIP  " + msg);
function fail(msg) {
  failures += 1;
  say(" ✗ FAIL  " + msg);
}
/** Assert or record a failure; returns the boolean so callers can short-circuit. */
function check(cond, okMsg, failMsg) {
  if (cond) pass(okMsg);
  else fail(failMsg);
  return Boolean(cond);
}

// ---------------------------------------------------------------------------
// Envelope validation — the external-consumer view of the wire format. This is
// deliberately a hand-rolled structural check (NOT our own parseSessionEventLine)
// so it proves a foreign process can read the log without our library.
// ---------------------------------------------------------------------------

function isEnvelope(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.v === 1 &&
    typeof value.sid === "string" &&
    value.sid.length > 0 &&
    Number.isInteger(value.seq) &&
    value.seq > 0 &&
    Number.isInteger(value.ts) &&
    value.ts > 0 &&
    typeof value.type === "string"
  );
}

/** Parse NDJSON text into the envelopes it contains (foreign/blank lines skipped). */
function parseEnvelopeLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // a torn tail line or foreign junk — a real consumer skips it
    }
    if (isEnvelope(obj)) out.push(obj);
  }
  return out;
}

function isMonotonic(events) {
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i + 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Child-process helpers.
// ---------------------------------------------------------------------------

/** Run node (optionally under tsx) once, capturing output with a hard timeout. */
function runNode(args, { cwd = CLI_ROOT, env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

/**
 * Spawn a streaming child (a tail/watch) and collect envelope events off its
 * stdout until `expected` have arrived, then SIGTERM it — mirroring how a
 * consumer kills `fleet watch`. Resolves with whatever was collected.
 */
function collectStream(
  args,
  { cwd = CLI_ROOT, env = {}, expected, timeoutMs = 12_000 },
) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collected = [];
    let buffer = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(collected);
    };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on("data", (d) => {
      buffer += d.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const obj = JSON.parse(trimmed);
          if (isEnvelope(obj)) collected.push(obj);
        } catch {
          // ignore non-envelope noise on the stream
        }
      }
      if (collected.length >= expected) finish();
    });
    child.on("close", () => finish());
    child.on("error", () => finish());
  });
}

// ---------------------------------------------------------------------------
// The tsx helper — the only code that imports TypeScript source. Written to a
// temp file at runtime and driven via `node --import tsx`. Absolute source
// paths arrive via env so its imports resolve regardless of where it lives.
// ---------------------------------------------------------------------------

const HELPER_SRC = [
  'import { pathToFileURL } from "node:url";',
  'import { join } from "node:path";',
  "const store = await import(pathToFileURL(process.env.SMOKE_STORE).href);",
  "const paths = await import(pathToFileURL(process.env.SMOKE_PATHS).href);",
  "const ids = await import(pathToFileURL(process.env.SMOKE_IDS).href);",
  "const { openFleetStore } = store;",
  "const { fleetRoot, sessionDir } = paths;",
  "const { newSessionId } = ids;",
  "const cmd = process.argv[2];",
  "const root = fleetRoot(process.cwd());",
  "const st = openFleetStore(root);",
  'if (cmd === "seed") {',
  "  const before = await st.listSessions();",
  "  const sid = newSessionId();",
  "  const started = Date.now();",
  '  const meta = await st.createSession({ sid, title: "pipe-smoke seed", prompt: "seed a session for the pipe smoke", owner: "worker", pid: process.pid, cwd: process.cwd(), mode: "once" });',
  "  const w = st.openWriter(meta);",
  "  const usage = { inputTokens: 120, outputTokens: 45, costUsd: 0.002 };",
  '  w.append({ type: "session.start", title: meta.title, prompt: meta.prompt, cwd: meta.cwd, mode: "once", owner: "worker", pid: process.pid });',
  '  w.append({ type: "session.state", state: "running" });',
  '  w.append({ type: "message", role: "user", text: meta.prompt, turn: 1 });',
  '  w.append({ type: "stage", kind: "execute", label: "Executing" });',
  '  w.append({ type: "tool.start", name: "read_file", input: JSON.stringify({ path: "README.md" }) });',
  '  w.append({ type: "tool.end", name: "read_file", ok: true, durationMs: 7 });',
  '  w.append({ type: "message.end", text: "Seeded assistant reply.", turn: 1 });',
  '  w.append({ type: "turn.end", turn: 1, steps: 2, changedFiles: [], usage });',
  '  w.append({ type: "usage", cumulative: usage });',
  '  const end = w.append({ type: "session.end", state: "done", summary: "pipe-smoke seeded session", durationMs: Date.now() - started, usage });',
  '  w.patchMeta({ state: "done", turns: 1, endedAt: Date.now(), summary: "pipe-smoke seeded session", usage });',
  "  await w.flush();",
  "  const after = await st.listSessions();",
  "  const dir = sessionDir(root, sid);",
  '  process.stdout.write("' + SENTINEL + '" + JSON.stringify({',
  "    sid, seqCount: end.seq, root, dir,",
  '    eventsFile: join(dir, "events.ndjson"),',
  '    metaFile: join(dir, "meta.json"),',
  "    beforeLen: before.length,",
  "    after: after.map((s) => ({ sid: s.sid, state: s.derivedState })),",
  '  }) + "\\n");',
  "  process.exit(0);",
  '} else if (cmd === "tail") {',
  "  const sid = process.argv[3];",
  '  const fromSeq = Number(process.argv[4] || "1");',
  '  const handle = st.tailEvents(sid, (e) => { process.stdout.write(JSON.stringify(e) + "\\n"); }, { fromSeq, intervalMs: 30 });',
  "  // The store's tail timers are unref'd; this ref'd deadline keeps us alive",
  "  // (and guarantees no zombie if the parent fails to SIGTERM us).",
  "  setTimeout(() => { handle.stop(); process.exit(0); }, 15000);",
  "} else {",
  '  process.stderr.write("unknown helper command: " + String(cmd) + "\\n");',
  "  process.exit(2);",
  "}",
].join("\n");

function helperEnv(fleetBase) {
  return {
    OXAGEN_FLEET_DIR: fleetBase,
    SMOKE_STORE: STORE_TS,
    SMOKE_PATHS: PATHS_TS,
    SMOKE_IDS: IDS_TS,
  };
}

/** Seed a session via the real store; returns the parsed helper result. */
async function seedSession(helperPath, fleetBase) {
  const res = await runNode(["--import", "tsx", helperPath, "seed"], {
    env: helperEnv(fleetBase),
    timeoutMs: 45_000,
  });
  const line = res.stdout.split("\n").find((l) => l.startsWith(SENTINEL));
  if (!line) {
    throw new Error(
      "seed helper produced no result. stderr:\n" + res.stderr.slice(-800),
    );
  }
  return JSON.parse(line.slice(SENTINEL.length));
}

// ---------------------------------------------------------------------------
// Leg A — store-level (must pass today).
// ---------------------------------------------------------------------------

async function legStoreLevel(helperPath) {
  say("");
  say("Leg A · store-level pipe (committed foundations)");
  const fleetBase = await mkdtemp(join(tmpdir(), "oxa-smoke-store-"));
  try {
    const seed = await seedSession(helperPath, fleetBase);
    info(`seeded ${seed.sid} (${seed.seqCount} events) into ${seed.root}`);

    // ls-equivalent: the store's roster was empty, then holds exactly our
    // terminal session (this is what `fleet ls --json | jq length` will read).
    check(
      seed.beforeLen === 0,
      "roster empty before seeding",
      `roster not empty before seeding (len=${seed.beforeLen})`,
    );
    check(
      seed.after.length === 1 && seed.after[0].sid === seed.sid,
      "fleet ls-equivalent → exactly 1 session, sid matches",
      `roster after seeding wrong: ${JSON.stringify(seed.after)}`,
    );
    check(
      seed.after[0]?.state === "done",
      "seeded session reads back terminal (done)",
      `unexpected derived state ${seed.after[0]?.state}`,
    );

    // logs-replay-equivalent: read events.ndjson from the OUTSIDE and parse it
    // as the envelope wire format with monotonic seq — the pipe contract.
    const raw = await readFile(seed.eventsFile, "utf8");
    const events = parseEnvelopeLines(raw);
    check(
      events.length === seed.seqCount,
      `events.ndjson replays ${events.length} parseable envelope lines`,
      `expected ${seed.seqCount} envelope lines, parsed ${events.length}`,
    );
    check(
      isMonotonic(events),
      "replayed seq is monotonic 1..N",
      `replayed seq not monotonic: ${events.map((e) => e.seq).join(",")}`,
    );
    check(
      events.every((e) => e.sid === seed.sid),
      "every replayed line carries the session sid",
      "a replayed line carried the wrong sid",
    );

    // meta.json is a complete roster document.
    const metaRaw = await readFile(seed.metaFile, "utf8");
    let metaOk = false;
    try {
      const meta = JSON.parse(metaRaw);
      metaOk =
        meta.sid === seed.sid &&
        meta.state === "done" &&
        meta.lastSeq === seed.seqCount;
    } catch {
      metaOk = false;
    }
    check(
      metaOk,
      "meta.json is complete and consistent with the log",
      "meta.json missing/torn or inconsistent with the log",
    );

    // watch-equivalent: tail the live log in a separate process and kill it
    // once the seeded events stream out.
    const streamed = await collectStream(
      ["--import", "tsx", helperPath, "tail", seed.sid, "1"],
      {
        env: helperEnv(fleetBase),
        expected: seed.seqCount,
      },
    );
    check(
      streamed.length >= seed.seqCount,
      `fleet watch-equivalent streamed ${streamed.length} envelope lines then was killed`,
      `tail streamed only ${streamed.length}/${seed.seqCount} envelope lines`,
    );
    check(
      isMonotonic(streamed.slice(0, seed.seqCount)),
      "streamed seq is monotonic 1..N",
      `streamed seq not monotonic: ${streamed.map((e) => e.seq).join(",")}`,
    );
  } catch (err) {
    fail("Leg A threw: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    await rm(fleetBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Leg B — the real `oxagen fleet … --json` pipe (auto-detected).
// ---------------------------------------------------------------------------

/** True once `oxagen fleet ls --json` is a real command that emits a JSON array. */
async function fleetCliWired(fleetBase) {
  const res = await runNode(
    ["--import", "tsx", CLI_ENTRY, "fleet", "ls", "--json"],
    {
      env: helperEnv(fleetBase),
      timeoutMs: 30_000,
    },
  );
  if (res.timedOut || res.code !== 0) return false;
  try {
    return Array.isArray(JSON.parse(res.stdout.trim()));
  } catch {
    return false;
  }
}

async function legCliSubprocess(helperPath) {
  say("");
  say("Leg B · real `oxagen fleet` NDJSON pipe");
  const fleetBase = await mkdtemp(join(tmpdir(), "oxa-smoke-cli-"));
  try {
    if (!(await fleetCliWired(fleetBase))) {
      skip(
        "`oxagen fleet` command tree unavailable in this environment — CLI pipe legs deferred",
      );
      return;
    }
    // Empty roster: `fleet ls --json | jq length` == 0.
    const lsEmpty = await runNode(
      ["--import", "tsx", CLI_ENTRY, "fleet", "ls", "--json"],
      { env: helperEnv(fleetBase) },
    );
    const emptyLen = JSON.parse(lsEmpty.stdout.trim()).length;
    check(
      emptyLen === 0,
      "fleet ls --json → jq length == 0 (empty)",
      `expected 0, got ${emptyLen}`,
    );

    // Seed one session (via the store) into the SAME fleet dir the CLI reads.
    const seed = await seedSession(helperPath, fleetBase);

    // `fleet ls --json | jq length` == 1.
    const lsOne = await runNode(
      ["--import", "tsx", CLI_ENTRY, "fleet", "ls", "--json"],
      { env: helperEnv(fleetBase) },
    );
    const roster = JSON.parse(lsOne.stdout.trim());
    check(
      roster.length === 1,
      "fleet ls --json → jq length == 1 after seed",
      `expected 1, got ${roster.length}`,
    );

    // `fleet logs <sid>` replays the log as parseable envelope lines.
    const logs = await runNode(
      ["--import", "tsx", CLI_ENTRY, "fleet", "logs", seed.sid, "--json"],
      { env: helperEnv(fleetBase) },
    );
    const logged = parseEnvelopeLines(logs.stdout);
    check(
      logged.length === seed.seqCount && isMonotonic(logged),
      "fleet logs → monotonic envelope lines",
      `fleet logs replay mismatch (${logged.length}/${seed.seqCount})`,
    );

    // `fleet watch --json` streams envelope lines; kill after the seeded events.
    const watched = await collectStream(
      ["--import", "tsx", CLI_ENTRY, "fleet", "watch", seed.sid, "--json"],
      {
        env: helperEnv(fleetBase),
        expected: seed.seqCount,
      },
    );
    check(
      watched.length >= seed.seqCount &&
        isMonotonic(watched.slice(0, seed.seqCount)),
      "fleet watch --json → monotonic envelope stream",
      `fleet watch stream mismatch (${watched.length}/${seed.seqCount})`,
    );
  } catch (err) {
    fail("Leg B threw: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    await rm(fleetBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Leg C — live detached dispatch (gated: OXAGEN_SMOKE_LIVE=1).
// ---------------------------------------------------------------------------

async function legLiveDispatch() {
  say("");
  say("Leg C · live detached dispatch");
  if (process.env.OXAGEN_SMOKE_LIVE !== "1") {
    skip(
      "live dispatch gated behind OXAGEN_SMOKE_LIVE=1 (real worker/model calls; needs task #4/#6)",
    );
    return;
  }
  const fleetBase = await mkdtemp(join(tmpdir(), "oxa-smoke-live-"));
  try {
    // Once dispatched, follow the worker to its fate:
    //   1) dispatch a trivial prompt, capture the printed sid,
    //   2) follow (`fleet dispatch --follow` / `fleet watch <sid> --json`),
    //   3) assert a terminal session.end envelope and a 0/1 exit matching its fate.
    const disp = await runNode(
      [
        "--import",
        "tsx",
        CLI_ENTRY,
        "fleet",
        "dispatch",
        "say hi",
        "--once",
        "--json",
      ],
      {
        env: helperEnv(fleetBase),
        timeoutMs: 120_000,
      },
    );
    const sid = disp.stdout.trim().split("\n").pop();
    if (disp.code !== 0 || !sid || !sid.startsWith("s-")) {
      fail(
        `live dispatch did not print a sid (code=${disp.code}); worker command likely not wired`,
      );
      return;
    }
    const streamed = await collectStream(
      ["--import", "tsx", CLI_ENTRY, "fleet", "watch", sid, "--json"],
      {
        env: helperEnv(fleetBase),
        expected: 1,
        timeoutMs: 120_000,
      },
    );
    const ended = streamed.some((e) => e.type === "session.end");
    check(
      ended,
      `live session ${sid} reached session.end`,
      `live session ${sid} never reached session.end`,
    );
  } catch (err) {
    fail("Leg C threw: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    await rm(fleetBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  say("fleet pipe smoke — " + new Date().toISOString());
  say("cli root: " + CLI_ROOT);

  const helperDir = await mkdtemp(join(tmpdir(), "oxa-smoke-helper-"));
  const helperPath = join(helperDir, "helper.mjs");
  await writeFile(helperPath, HELPER_SRC);

  try {
    await legStoreLevel(helperPath);
    await legCliSubprocess(helperPath);
    await legLiveDispatch();
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }

  say("");
  if (failures === 0)
    say(
      "SUMMARY: all required legs passed (skips are deferred, not failures).",
    );
  else say(`SUMMARY: ${failures} check(s) FAILED.`);

  const out = process.env.OXAGEN_SMOKE_OUT;
  if (out) {
    try {
      await writeFile(out, transcript.join("\n") + "\n");
      process.stderr.write("transcript written to " + out + "\n");
    } catch (err) {
      process.stderr.write(
        "could not write OXAGEN_SMOKE_OUT: " + String(err) + "\n",
      );
    }
  }

  process.exitCode = failures === 0 ? 0 : 1;
  // Give any SIGTERM'd stream children a tick to die before we return.
  await delay(50);
}

main().catch((err) => {
  process.stderr.write(
    "smoke harness crashed: " +
      (err instanceof Error ? err.stack : String(err)) +
      "\n",
  );
  process.exitCode = 1;
});
