import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NEXT_CACHE_APPS,
  cleanShutdownMarker,
  guardTurbopackCaches,
  markCleanShutdown,
} from "./lib/next-cache-guard";

describe("next-cache-guard", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cache-guard-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const nextDir = (app: string): string => resolve(root, app, ".next");

  it("wipes a cache left without a clean-shutdown marker (unclean death)", () => {
    mkdirSync(nextDir("apps/app"), { recursive: true });
    writeFileSync(join(nextDir("apps/app"), "some-cache-file"), "x");

    const wiped = guardTurbopackCaches(root);

    expect(wiped).toEqual(["apps/app"]);
    expect(existsSync(nextDir("apps/app"))).toBe(false);
  });

  it("preserves a cache vouched for by the marker and consumes the marker", () => {
    mkdirSync(nextDir("apps/app"), { recursive: true });
    writeFileSync(cleanShutdownMarker(root, "apps/app"), "2026-07-09");

    const wiped = guardTurbopackCaches(root);

    expect(wiped).toEqual([]);
    expect(existsSync(nextDir("apps/app"))).toBe(true);
    // Marker is single-use: the NEXT boot after another unclean death must wipe.
    expect(existsSync(cleanShutdownMarker(root, "apps/app"))).toBe(false);
    expect(guardTurbopackCaches(root)).toEqual(["apps/app"]);
  });

  it("ignores apps with no .next at all", () => {
    expect(guardTurbopackCaches(root)).toEqual([]);
  });

  it("markCleanShutdown stamps every existing cache and skips missing ones", () => {
    mkdirSync(nextDir("apps/app"), { recursive: true });

    markCleanShutdown(root);

    expect(existsSync(cleanShutdownMarker(root, "apps/app"))).toBe(true);
    expect(existsSync(cleanShutdownMarker(root, "apps/docs"))).toBe(false);
  });

  it("guards every registered app independently", () => {
    for (const app of NEXT_CACHE_APPS)
      mkdirSync(nextDir(app), { recursive: true });
    writeFileSync(cleanShutdownMarker(root, "apps/app"), "x");

    const wiped = guardTurbopackCaches(root);

    expect(wiped).toEqual(["apps/docs"]);
    expect(existsSync(nextDir("apps/app"))).toBe(true);
    expect(existsSync(nextDir("apps/docs"))).toBe(false);
  });

  it("reports wipes through the onWipe callback", () => {
    mkdirSync(nextDir("apps/app"), { recursive: true });
    const seen: string[] = [];

    guardTurbopackCaches(root, (app) => seen.push(app));

    expect(seen).toEqual(["apps/app"]);
  });
});
