// The dark theme is written down twice in assets/oxagen.css: once for a
// theme pinned by the toggle (`:root.dark`) and once for a visitor whose
// system prefers dark (`:root:not(.light)` inside the media query). CSS has
// no way to share one declaration list between a class and a media query, so
// this test is what keeps the two from drifting, and what keeps every dark
// token overriding something the light theme actually declares.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, "../assets/oxagen.css"), "utf8");

/** The declarations of the first rule whose selector text is `selector`. */
export function block(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated rule for ${selector}`);
}

/** `--name: value` pairs (plus color-scheme), comments dropped, whitespace folded. */
export function declarations(body) {
  const out = new Map();
  const text = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

describe("theme tokens", () => {
  const light = declarations(block(CSS, ":root"));
  const pinned = declarations(block(CSS, ":root.dark,\n.term"));
  const media = block(CSS, "@media (prefers-color-scheme: dark)");
  const system = declarations(block(media, ":root:not(.light)"));

  it("declares the same dark theme for a pin and for the system", () => {
    expect(pinned.size).toBeGreaterThan(20);
    expect(Object.fromEntries(system)).toEqual(Object.fromEntries(pinned));
  });

  it("only overrides tokens the light theme declares", () => {
    const orphans = [...pinned.keys()].filter((k) => !light.has(k));
    expect(orphans).toEqual([]);
  });

  it("gives the dark theme a different value for every surface and ink", () => {
    for (const k of ["--ground", "--panel", "--line", "--ink", "--ink-3", "--gold"]) {
      expect(pinned.get(k), k).not.toEqual(light.get(k));
    }
  });

  it("catches a drifted token", () => {
    const drifted = new Map(system);
    drifted.set("--ground", "var(--st-panel)");
    expect(Object.fromEntries(drifted)).not.toEqual(Object.fromEntries(pinned));
  });
});
