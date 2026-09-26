/**
 * The stylesheet loads the house faces and routes every colour and face
 * through an --ox-* token (#3348). It used to import Space Grotesk alone, so
 * the body's Geist and the code's Monaspace Neon never loaded and the app
 * rendered in the platform fallback, with the wordmark in Geist.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const require = createRequire(import.meta.url);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1];
  if (body === undefined) throw new Error(`no ${selector} rule in styles.css`);
  return body;
}

describe("styles.css fonts", () => {
  it("imports the house font faces from @oxagen/ui", () => {
    expect(css).toContain('@import "@oxagen/ui/styles/house-fonts.css";');
  });

  it("imports a path @oxagen/ui exports, which declares Geist and Monaspace Neon", () => {
    const path = require.resolve("@oxagen/ui/styles/house-fonts.css");
    const faces = readFileSync(path, "utf8");
    expect(faces).toMatch(/font-family:\s*"Geist"/);
    expect(faces).toMatch(/font-family:\s*"Monaspace Neon"/);
    expect(faces).toMatch(/font-family:\s*"Space Grotesk"/);
  });

  it("sets the wordmark in the display face", () => {
    expect(rule(".wordmark")).toMatch(
      /font-family:\s*var\(--ox-font-display\);/,
    );
  });

  it("sets code in the house mono face", () => {
    expect(rule(":root")).toMatch(/--mono:\s*var\(--ox-font-mono\);/);
  });
});

describe("styles.css colours", () => {
  it("carries no hex colour of its own", () => {
    // Every colour comes from house-tokens.css. A literal here is a value
    // the next reskin has to find by hand, as --hl's warm cream was.
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });
});
