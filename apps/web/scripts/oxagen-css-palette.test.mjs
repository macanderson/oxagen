// assets/oxagen.css against the house palette (#3348). The hex texture is a
// data URI, so its colours are literals that no token change can reach. The
// dark variant kept the retired paper cream as its stroke after the rest of
// the site moved to obsidian and white.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("../assets/oxagen.css", import.meta.url)),
  "utf8",
);

// The warm gold ramp and the paper cream the obsidian and white kit retired.
const RETIRED = ["8B5E1A", "D6962C", "F1C364", "F2EEE5"];

/** The SVG inside one `--name: url("data:image/svg+xml;utf8,...")` token. */
function texture(name) {
  const match = new RegExp(
    `${name}:\\s*url\\("data:image/svg\\+xml;utf8,([^"]*)"\\)`,
  ).exec(CSS);
  if (!match) throw new Error(`no ${name} data URI in oxagen.css`);
  return decodeURIComponent(match[1]);
}

describe("oxagen.css palette", () => {
  it("carries none of the retired colours", () => {
    for (const hex of RETIRED) {
      expect(CSS, hex).not.toMatch(new RegExp(hex, "i"));
    }
  });

  it("strokes the ink hex texture in white and the paper one in ink", () => {
    expect(texture("--tex-hex")).toContain("stroke='#FFFFFF'");
    expect(texture("--tex-hex-paper")).toContain("stroke='#09090B'");
  });

  it("runs both hex textures on the house gold ramp", () => {
    for (const name of ["--tex-hex", "--tex-hex-paper"]) {
      const svg = texture(name);
      expect(svg).toContain("stop-color='#8A7223'");
      expect(svg).toContain("stop-color='#D4AF37'");
      expect(svg).toContain("stop-color='#F1CE65'");
    }
  });
});
