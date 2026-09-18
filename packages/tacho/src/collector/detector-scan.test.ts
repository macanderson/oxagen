/**
 * The transcript scanner against a large fake project tree: a tick yields
 * the event loop while it scans, scans at most its share of directories per
 * tick and reaches the rest on later ticks, rescans a directory whose mtime
 * moved at once, and re-stats a watched file every tick.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DIRS_PER_TICK, TranscriptScanner } from "./detector";

const FILES_PER_PROJECT = 5;

function sessionName(project: number, file: number): string {
  const p = project.toString(16).padStart(8, "0");
  const f = file.toString(16).padStart(12, "0");
  return `${p}-0000-4000-8000-${f}.jsonl`;
}

describe("TranscriptScanner", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  function tree(projects: number): string {
    const root = mkdtempSync(join(tmpdir(), "tacho-scan-"));
    dirs.push(root);
    for (let p = 0; p < projects; p += 1) {
      const dir = join(root, `-project-${p}`);
      mkdirSync(dir);
      for (let f = 0; f < FILES_PER_PROJECT; f += 1)
        writeFileSync(join(dir, sessionName(p, f)), "{}\n");
      writeFileSync(join(dir, "notes.txt"), "not a transcript");
    }
    return root;
  }

  it("yields the event loop while it scans a large tree", async () => {
    const root = tree(300);
    const scanner = new TranscriptScanner([root], 300);
    let timerFired = false;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0),
    );
    const entries = await scanner.tick();
    // The whole tree was asked for in one tick, and the timer still ran
    // before the tick finished: nothing held the thread across the scan.
    expect(entries).toHaveLength(300 * FILES_PER_PROJECT);
    expect(timerFired).toBe(true);
    await timer;
  });

  it("scans at most its share of directories per tick and reaches the rest later", async () => {
    const root = tree(100);
    const scanner = new TranscriptScanner([root]);
    const first = await scanner.tick();
    expect(first.length).toBeLessThanOrEqual(
      MAX_DIRS_PER_TICK * FILES_PER_PROJECT,
    );
    expect(first.length).toBeGreaterThan(0);
    let all = first;
    for (let i = 0; i < 4 && all.length < 100 * FILES_PER_PROJECT; i += 1)
      all = await scanner.tick();
    expect(all).toHaveLength(100 * FILES_PER_PROJECT);
    expect(new Set(all.map((e) => e.sessionId)).size).toBe(
      100 * FILES_PER_PROJECT,
    );
  });

  it("rescans a directory whose mtime moved at once, and re-stats a watched file every tick", async () => {
    const root = tree(3);
    const scanner = new TranscriptScanner([root], 4);
    const seen = await scanner.tick();
    expect(seen).toHaveLength(3 * FILES_PER_PROJECT);
    // A new transcript in a directory: its mtime moves, it is rescanned.
    const added = join(root, "-project-1", sessionName(1, 9));
    writeFileSync(added, "{}\n");
    const now = Date.now() + 60_000;
    utimesSync(join(root, "-project-1"), new Date(now), new Date(now));
    const next = await scanner.tick();
    expect(next.map((e) => e.path)).toContain(added);
    // A transcript that only grows in place leaves its directory's mtime
    // alone; it is re-statted when watched, and picked up by the rotation
    // otherwise.
    const target = join(root, "-project-2", sessionName(2, 0));
    const before = next.find((e) => e.path === target)?.mtimeMs ?? 0;
    utimesSync(target, new Date(now + 5_000), new Date(now + 5_000));
    const watched = await scanner.tick(new Set([target]));
    expect(watched.find((e) => e.path === target)?.mtimeMs).toBeGreaterThan(
      before,
    );
    // A removed directory is forgotten.
    rmSync(join(root, "-project-0"), { recursive: true });
    const after = await scanner.tick();
    expect(after.some((e) => e.path.includes("-project-0"))).toBe(false);
    // A root that is not there scans as empty.
    expect(await new TranscriptScanner([join(root, "nope")]).tick()).toEqual(
      [],
    );
  });
});
