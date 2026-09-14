/**
 * `oxagen logs --follow` — the live-tail half of the logs command, which the
 * main logs suite deliberately does not enter (it blocks on a real `watch()`).
 * Here `node:fs`'s watcher is replaced so the two things worth pinning can be
 * asserted deterministically: the drain prints ONLY entries appended since the
 * last pass (and serializes overlapping watch events instead of double-printing
 * them), and an un-watchable file degrades to a message rather than hanging.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "oxa-logsfollow-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: watchMock };
});

import { handleLogs } from "../logs.js";
import { debugLog, clearDebugLog, DEBUG_ENV } from "../../lib/debug-log.js";

let out = "";
let err = "";
let outWrite: typeof process.stdout.write;
let errWrite: typeof process.stderr.write;

beforeEach(() => {
  out = "";
  err = "";
  watchMock.mockReset();
  outWrite = process.stdout.write.bind(process.stdout);
  errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  process.env[DEBUG_ENV] = "1";
});

afterEach(async () => {
  process.env[DEBUG_ENV] = "1";
  await clearDebugLog();
  delete process.env[DEBUG_ENV];
  process.stdout.write = outWrite;
  process.stderr.write = errWrite;
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/**
 * Poll until `predicate` holds. Every wait in this file is on work the command
 * does asynchronously (a `readDebugLog` per drain), so a fixed sleep is a bet
 * on the machine rather than an assertion about the code: on a loaded CI runner
 * the 10ms one here expired mid-drain and the suite asserted on an empty stdout.
 * The timeout throws naming what it waited for, so a genuine hang still fails
 * with the reason instead of an `expected undefined to be defined`.
 */
async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("oxagen logs --follow", () => {
  it("prints a message and returns when the file cannot be watched", async () => {
    watchMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });

    await handleLogs({ follow: true });

    expect(err).toContain("Cannot follow");
    expect(err).toContain("ENOENT: no such file");
  });

  it("prints only entries appended after follow started, then stops on SIGINT", async () => {
    await debugLog("turn", "before.follow");

    let listener: (() => void) | undefined;
    const close = vi.fn();
    watchMock.mockImplementation(
      (_file: string, _opts: unknown, cb: () => void) => {
        listener = cb;
        return { close };
      },
    );

    const stops: (() => void)[] = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: () => void,
    ) => {
      if (event === "SIGINT" || event === "SIGTERM") stops.push(handler);
      return process;
    }) as typeof process.on);

    const running = handleLogs({ follow: true });
    // The command computes its `seen` baseline before it calls `watch`, so a
    // defined listener is the signal that the pre-follow tail and the baseline
    // read are both done and an append now counts as new.
    await waitUntil(() => listener !== undefined, "follow mode to start watching");

    await debugLog("turn", "after.follow");
    listener!();
    // Two watch events for one append must collapse into one drain, not print twice.
    listener!();
    await waitUntil(() => out.includes("after.follow"), "the drain to print the new entry");
    // The second event queued a trailing re-read. Wait for stdout to stay
    // unchanged across consecutive polls so a double print is caught here
    // rather than raced past by the assertion below.
    let previous = "";
    let settled = 0;
    await waitUntil(() => {
      settled = previous === out ? settled + 1 : 0;
      previous = out;
      return settled >= 3;
    }, "stdout to go quiet after the drain");

    expect(stops.length).toBeGreaterThan(0);
    stops[0]!();
    await running;

    onSpy.mockRestore();
    expect(close).toHaveBeenCalled();
    expect(err).toContain("Following");
    expect(out).toContain("after.follow");
    // The entry that predates follow mode was already on screen from the tail,
    // so the drain must not repeat it, and the new one must appear exactly once.
    expect(out.match(/after\.follow/g)).toHaveLength(1);
  });
});
