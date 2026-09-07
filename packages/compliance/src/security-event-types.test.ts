import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMITTED_SECURITY_EVENT_TYPES,
  RESERVED_SECURITY_EVENT_TYPES,
  SECURITY_EVENT_TYPES,
  isEmittedSecurityEventType,
} from "./security-event-types";

/**
 * The repository root, found by walking up for the workspace manifest.
 *
 * Deliberately not `git rev-parse`: the CI container runs as a different user
 * than the checkout owner, so git refuses with "detected dubious ownership" and
 * a module-level call takes the whole file down with it. The question this scan
 * asks — does any shipping file mention this literal — is about the filesystem,
 * not about git, so it asks the filesystem.
 */
function repoRoot(): string {
  let dir = resolve(import.meta.dirname);
  for (let up = 0; up < 10; up += 1) {
    try {
      statSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "could not locate the workspace root from " + import.meta.dirname,
  );
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__snapshots__",
]);

/**
 * Every shipping source file under `packages/` and `apps/`.
 *
 * Tests are excluded, and that distinction is the point: a test asserting a type
 * is NOT offered mentions the literal without emitting it, so counting tests
 * would let a type look covered because something checks it is absent. The
 * taxonomy itself is excluded for the same reason — it declares the names.
 */
function shippingSources(): string[] {
  const root = repoRoot();
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(full);
        }
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      if (entry.name.includes(".test.")) continue;
      if (entry.name.startsWith("security-event-types")) continue;
      out.push(full);
    }
  };

  walk(join(root, "packages"));
  walk(join(root, "apps"));
  return out;
}

/** Event-type literals that appear in shipping source, computed in one pass. */
function referencedTypes(): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of shippingSources()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const type of SECURITY_EVENT_TYPES) {
      if (!found.has(type) && text.includes(`"${type}"`)) found.add(type);
    }
  }
  return found;
}

describe("the emitted subset", () => {
  it("is the full union minus the reserved list, with no third copy to drift", () => {
    expect(new Set(EMITTED_SECURITY_EVENT_TYPES)).toEqual(
      new Set(
        SECURITY_EVENT_TYPES.filter(
          (t) => !RESERVED_SECURITY_EVENT_TYPES.includes(t as never),
        ),
      ),
    );
    expect(
      EMITTED_SECURITY_EVENT_TYPES.length +
        RESERVED_SECURITY_EVENT_TYPES.length,
    ).toBe(SECURITY_EVENT_TYPES.length);
  });

  it("excludes every reserved type", () => {
    for (const type of RESERVED_SECURITY_EVENT_TYPES) {
      expect(EMITTED_SECURITY_EVENT_TYPES, type).not.toContain(type);
      expect(isEmittedSecurityEventType(type), type).toBe(false);
    }
  });

  it("keeps the full union intact for the DB CHECK and historical rows", () => {
    // Narrowing what a UI offers must never narrow what the column accepts.
    for (const type of RESERVED_SECURITY_EVENT_TYPES) {
      expect(SECURITY_EVENT_TYPES).toContain(type);
    }
  });

  it("names the eight the audit found", () => {
    expect(RESERVED_SECURITY_EVENT_TYPES).toHaveLength(8);
  });
});

/**
 * The markers are only worth anything if they are true. These fail in BOTH
 * directions, which is what the module's note asks for: a reserved type that
 * gained an emitter is a stale marker, and a non-reserved type that lost its
 * last one is a type quietly reading as covered.
 */
describe("the RESERVED markers match the repository", () => {
  it("finds no emitter for any reserved type", () => {
    const referenced = referencedTypes();
    const stale = RESERVED_SECURITY_EVENT_TYPES.filter((t) =>
      referenced.has(t),
    );
    expect(
      stale,
      `these are marked RESERVED but something now references them — ` +
        `move them into the emitted set: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("finds a reference for every emitted type", () => {
    const referenced = referencedTypes();
    const orphaned = EMITTED_SECURITY_EVENT_TYPES.filter(
      (t) => !referenced.has(t),
    );
    expect(
      orphaned,
      `these are offered as filterable but nothing references them — ` +
        `mark them RESERVED: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });
});
