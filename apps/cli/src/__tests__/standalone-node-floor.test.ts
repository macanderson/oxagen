/**
 * The published `oxagen` CLI promises npm a Node in its manifest's `engines`,
 * and its bundle is built for a Node in esbuild's `target`. The bundle carries
 * the recorder's daemon, which imports zstd from `node:zlib` statically, and
 * Node added zstd in 22.15 and 23.8. The manifest promised Node 20, so npm
 * installed a CLI that failed to link on an older Node.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, "..", "..", "scripts");
const script = (name: string) => readFileSync(resolve(scripts, name), "utf8");

/** Each esbuild `target` a script names, as `[major, minor]`. */
function nodeTargets(source: string): [number, number][] {
  return [...source.matchAll(/target: "node(\d+)(?:\.(\d+))?"/g)].map(
    (match): [number, number] => [
      Number(match[1] ?? 0),
      Number(match[2] ?? 0),
    ],
  );
}

describe("the Node the standalone CLI needs", () => {
  it("promises npm only a Node that has zstd in node:zlib", () => {
    expect(script("prepare-standalone-publish.mjs")).toContain(
      'engines: { node: "^22.15.0 || >=23.8.0" }',
    );
  });

  it("builds every bundle for Node 22.15 or later, and none for Node 20 (negative)", () => {
    const targets = nodeTargets(script("bundle.mjs"));
    expect(targets).toContainEqual([22, 15]);
    for (const [major, minor] of targets)
      expect(major > 22 || (major === 22 && minor >= 15)).toBe(true);
  });
});
