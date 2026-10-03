// The published recorder promises npm a Node in its manifest's `engines`, and
// its bundles are built for a Node in esbuild's `target`. The daemon imports
// zstd from `node:zlib` statically (`collector/model-proxy.ts`), and Node
// added zstd in 22.15 and 23.8. The manifest promised Node 20, so npm
// installed a daemon that failed to link on an older Node and recorded
// nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)),
    "utf8",
  );

/** Each esbuild `target` a script names, as `[major, minor]`. */
function nodeTargets(source: string): [number, number][] {
  return [...source.matchAll(/target: "node(\d+)(?:\.(\d+))?"/g)].map(
    (match): [number, number] => [
      Number(match[1] ?? 0),
      Number(match[2] ?? 0),
    ],
  );
}

describe("the Node the standalone recorder needs", () => {
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
