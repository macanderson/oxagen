import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No handler reads the batch's enforcement-tier attribute.
 *
 * `oxagen.enforcement_tier` is written by the daemon and it is true of the
 * EVENT: that call really did come through the local MCP gateway, and an
 * operator reading the stream wants to see which ones did. It is not true of
 * the SESSION in any way the control plane can check, because everything in a
 * submitted batch is chosen by whoever submitted it.
 *
 * Twice now the tier has been derived from it and twice it has been a P1. The
 * first time it decided the tier outright (discussion_r4036718127). The second
 * time it decided only *which session* a real server observation belonged to —
 * which sounded like correlation rather than authority, and was the whole
 * attack: one reusable timestamp, and the submitter choosing where it landed
 * (#3221).
 *
 * The attribute is still written, so it is still there to be picked up by the
 * next person who needs to know which chain served a gateway call. This test is
 * the note that says: ask `tacho.gateway_chains`, which is the control
 * plane's own record, not the batch.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** The attribute, spelled as the daemon spells it. */
const ATTR = "oxagen.enforcement_tier";
/** …and as `@oxagen/tacho` names it, which is how a handler would import it. */
const CONST = "TACHO_ENFORCEMENT_TIER_ATTR";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.includes("test-support")) continue;
    out.push(path);
  }
  return out;
}

function readers(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const found: string[] = [];
  for (const needle of [ATTR, CONST]) {
    let at = source.indexOf(needle);
    while (at !== -1) {
      // A mention in a comment is the opposite of the problem: it is somebody
      // writing down why this is not read. Only code counts.
      const lineStart = source.lastIndexOf("\n", at) + 1;
      const line = source.slice(lineStart, source.indexOf("\n", at));
      const trimmed = line.trim();
      const isComment =
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*");
      if (!isComment) {
        found.push(
          `${path.slice(SRC.length + 1)}:${source.slice(0, at).split("\n").length} ${trimmed}`,
        );
      }
      at = source.indexOf(needle, at + needle.length);
    }
  }
  return found;
}

describe("the submitted enforcement-tier attribute", () => {
  it("is not read by any handler", () => {
    const files = sourceFiles(SRC);
    // The scan is worthless if it reads nothing; a broken path would pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap(readers)).toEqual([]);
  });

  it("detects a read that is not a comment", () => {
    // The discriminating case. A test that only asserts the tree is clean
    // passes just as well when the scan matches nothing at all.
    const code = `  if (event.attrs?.["${ATTR}"] === "gateway") return true;`;
    const comment = `  // never read ${ATTR} for the tier — see #3221`;
    const scan = (line: string): boolean => {
      const trimmed = line.trim();
      return (
        line.includes(ATTR) &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*")
      );
    };
    expect(scan(code)).toBe(true);
    expect(scan(comment)).toBe(false);
  });
});
