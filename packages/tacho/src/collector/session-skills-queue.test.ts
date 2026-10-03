// session-skills-queue.test.ts: the daemon places and removes skills one
// call at a time, and a call that waits too long for the one before it is
// skipped and logged, so it never holds its hook.
//
// placeSkills and removeSkills are replaced with doubles that finish when a
// test says, so the order of two sessions' calls can be checked step by
// step. Nothing here touches a disk.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeSkill,
  type PlaceResult,
  type RemoveResult,
  type SessionSkill,
} from "../skills";
import type { BundleSkill } from "../wire";

const mocks = vi.hoisted(() => ({
  place: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills")>()),
  placeSkills: mocks.place,
  removeSkills: mocks.remove,
}));

const { sessionSkills } = await import("./session-skills");

const NOW = new Date("2026-09-27T01:00:00.000Z");
const HOME = join(tmpdir(), "session-skills-queue");
const PLACED: PlaceResult = { placed: [], skipped: [], warnings: [] };
const REMOVED: RemoveResult = { removed: [], kept: [] };

function skill(name: string): BundleSkill {
  const decoded: SessionSkill = {
    lineage: `a-intel.${name}`,
    name,
    description: `The ${name} skill.`,
    body: `# ${name}\n`,
    files: [],
    source: "workspace",
    version: 3,
  };
  return encodeSkill(decoded);
}

/** A promise a test settles by hand. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

/** Let every callback already queued run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let lines: string[];

beforeEach(() => {
  lines = [];
  mocks.place.mockReset();
  mocks.remove.mockReset();
});

function subject(waitMs = 60_000) {
  return sessionSkills({
    home: HOME,
    now: () => NOW,
    log: (line) => lines.push(line),
    waitMs,
  });
}

describe("sessionSkills runs one call at a time", () => {
  it("starts a session's place only after another session's removal has finished", async () => {
    const removal = deferred<RemoveResult>();
    mocks.remove.mockImplementation(() => removal.promise);
    mocks.place.mockResolvedValue(PLACED);
    const skills = subject();
    const ending = skills.remove("claude-code", "session-a", {});
    const starting = skills.place(
      "claude-code",
      "session-b",
      [skill("brand-voice")],
      {},
    );
    await flush();
    // Run side by side, the place reads a marker the removal is about to
    // delete the folder under.
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.place).not.toHaveBeenCalled();
    removal.resolve(REMOVED);
    await Promise.all([ending, starting]);
    expect(mocks.place).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it("hands on its turn when a call fails", async () => {
    mocks.place
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(PLACED);
    const skills = subject();
    await Promise.all([
      skills.place("claude-code", "session-a", [skill("brand-voice")], {}),
      skills.place("claude-code", "session-b", [skill("brand-voice")], {}),
    ]);
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      `skills: session session-a starts without its skills, because writing them to ${join(HOME, ".claude", "skills")} failed: disk full`,
    ]);
  });

  it("skips and logs a call that waits past the bound, and the next call still waits for the slow one", async () => {
    // Fake timers, so the third call cannot run out its own wait while the
    // test is still holding the first.
    vi.useFakeTimers();
    try {
      const removal = deferred<RemoveResult>();
      mocks.remove.mockImplementation(() => removal.promise);
      mocks.place.mockResolvedValue(PLACED);
      const skills = subject(10);
      const ending = skills.remove("claude-code", "session-a", {});
      const skipped = skills.place(
        "claude-code",
        "session-b",
        [skill("brand-voice")],
        {},
      );
      await vi.advanceTimersByTimeAsync(10);
      await skipped;
      expect(mocks.remove).toHaveBeenCalledTimes(1);
      expect(mocks.place).not.toHaveBeenCalled();
      expect(lines).toEqual([
        "skills: session session-b starts without its skills, because another session's skills were still being written or removed after 10 ms.",
      ]);
      const later = skills.place(
        "claude-code",
        "session-c",
        [skill("brand-voice")],
        {},
      );
      await vi.advanceTimersByTimeAsync(0);
      // The removal is still running, so the third call waits for it even
      // though the second has given up its turn.
      expect(mocks.place).not.toHaveBeenCalled();
      removal.resolve(REMOVED);
      await Promise.all([ending, later]);
      expect(mocks.place).toHaveBeenCalledTimes(1);
      expect(mocks.place.mock.calls[0]?.[1]).toBe("session-c");
    } finally {
      vi.useRealTimers();
    }
  });
});
