#!/usr/bin/env node
/**
 * The app's type audit: every font size in apps/app and packages/ui, resolved
 * from the kit's tokens, against the kit's type roles (ADR-298).
 *
 *     node tools/scripts/type-audit.mjs            # the report
 *     node tools/scripts/type-audit.mjs --json     # the same as data
 *     node tools/scripts/type-audit.mjs --mockup ../oxagen-roadmap
 *
 * It reads files and writes nothing. INV-36 (`type-scale.test.ts`) already
 * fails a size written by hand, so every size here is a Tailwind step or a
 * `var(--ox-a-*)` token, and the audit can say what each one draws at the
 * kit's base. It then asks the question INV-36 cannot: does the size fit the
 * role of the element it sits on?
 *
 * The kit (`oxageninc/brand`, theme/theme.schema.json) gives each app step a
 * role. Body is running text, buttons, inputs, menu items, and table cells.
 * Micro is a label, a badge, a timestamp, or a table header. 2xs is a dense
 * table header, a small badge, a menu group label, or a chart axis. #5292
 * assigned classes by the pixel size the mockup drew and snapped down, which
 * put eyebrows on 2xs and table cells on micro. The flags below name each
 * site that still sits under its role, so the next pass can move it and no
 * later sweep snaps a size down again.
 *
 * With `--mockup <dir>`, or a sibling `oxagen-roadmap` checkout, it also reads
 * the mockup's stylesheets at the ADR-226 pin and shows how far each mockup
 * size sits from the nearest step. That table is context, not a flag: ADR-226
 * gives type to the kit and layout to the mockup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

/** The kit's base in CSS pixels: 1rem is 16px in every browser's default. */
const REM = 16;
/** Tailwind's text steps, smallest first. Larger steps read no app step. */
export const STEPS = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"];
/** Elements whose text a person reads as a sentence or a value: the body role. */
const RUNNING = new Set(["p", "td", "dd", "li", "button", "input", "textarea", "select", "label", "blockquote"]);
/** Elements that carry a label: the micro role. */
const LABEL = new Set(["dt", "th", "time", "small", "caption", "figcaption", "legend", "sup", "sub", "kbd"]);
/** The one place the kit lets text go under micro: an axis on a chart. */
const AXIS = /(waterfall|chart|sparkline|axis|histogram)/i;
/** The kit lets a small badge take 2xs, and the shared badge is the one component that draws one. */
const BADGE = /\/badge\.tsx$/;
const LEADING_TIGHT = /\bleading-(none|tight)\b/;
const SIZE_CLASS = /\btext-(xs|sm|base|lg|xl|2xl|3xl)\b/g;
const SIZE_VAR = /font-size:\s*var\(--ox-a-([a-z0-9]+)\)/g;
const TAG = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*$/;
const SKIP = /(^|\/)(node_modules|dist|\.next|coverage|__snapshots__|probes)(\/|$)|\.test\.|\.stories\.|\/house-[a-z-]+\.css$/;

/* ---------- the scale ---------- */

/**
 * Every `--ox-a-<step>` in the kit's tokens as `{ px, leading }`, from the
 * base and each step's ratio. Reads `house-tokens.css` as the brand sync
 * writes it into packages/ui.
 */
export function readScale(tokensCss) {
  const base = /--ox-a-base:\s*([\d.]+)rem/.exec(tokensCss);
  if (!base) throw new Error("house-tokens.css has no --ox-a-base in rem");
  const basePx = Number(base[1]) * REM;
  const steps = { base: { px: basePx, leading: null } };
  for (const m of tokensCss.matchAll(/--ox-a-([a-z0-9]+):\s*(?:calc\(var\(--ox-a-base\)\s*\*\s*([\d.]+)\)|var\(--ox-a-base\))\s*;/g)) {
    steps[m[1]] = { px: round(basePx * (m[2] === undefined ? 1 : Number(m[2]))), leading: null };
  }
  for (const m of tokensCss.matchAll(/--ox-a-([a-z0-9]+)-leading:\s*([\d.]+)\s*;/g)) {
    if (steps[m[1]]) steps[m[1]].leading = Number(m[2]);
  }
  return { basePx, steps };
}

/**
 * The `--text-<name>` to app step map in cascade order. It follows the app's
 * entry stylesheet and every `@import` it names, the way INV-36 does, and a
 * later block wins, as it does in Tailwind.
 */
export function readTailwindMap(entry, { read = (f) => readFileSync(f, "utf8"), exists = existsSync, uiStyles } = {}) {
  const map = {};
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !exists(file)) return;
    seen.add(file);
    const css = read(file);
    for (const m of css.matchAll(/@import\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      const target = spec.startsWith("@oxagen/ui/styles/")
        ? join(uiStyles, spec.slice("@oxagen/ui/styles/".length))
        : spec.startsWith(".")
          ? resolve(dirname(file), spec)
          : null;
      if (target) visit(target.endsWith(".css") ? target : `${target}.css`);
    }
    for (const m of css.matchAll(/--text-(xs|sm|base|lg|xl|2xl|3xl):\s*var\(--ox-a-([a-z0-9]+)\)/g)) {
      map[m[1]] = m[2];
    }
  };
  visit(entry);
  return map;
}

/* ---------- the sites ---------- */

/** The JSX tag a class string sits on: the last open tag before it on the line or the lines above. */
export function tagBefore(lines, index, column) {
  const head = lines[index].slice(0, column);
  const own = TAG.exec(head);
  if (own) return own[1].toLowerCase();
  for (let i = index - 1; i >= Math.max(0, index - 6); i--) {
    const m = TAG.exec(lines[i]);
    if (m) return m[1].toLowerCase();
    if (/>\s*$/.test(lines[i]) && !/<[a-zA-Z]/.test(lines[i])) break;
  }
  return null;
}

/** The role an element's text has, by the kit's table. */
export function roleOf(tag, classes, file) {
  if (AXIS.test(file) && (tag === "text" || tag === "tspan")) return "axis";
  if (BADGE.test(file)) return "badge";
  if (tag && /^h[1-6]$/.test(tag)) return "heading";
  if (/\bfont-mono\b/.test(classes)) return "data";
  if (tag && RUNNING.has(tag)) return "body";
  if (tag && LABEL.has(tag)) return "label";
  if (/\buppercase\b/.test(classes)) return "label";
  return "unknown";
}

/** The smallest size a role may draw at, in px, on the given scale. */
export function floorOf(role, scale) {
  const px = (name) => scale.steps[name]?.px ?? 0;
  if (role === "body") return px("body");
  if (role === "axis" || role === "badge") return px("2xs");
  return px("micro");
}

/** The flags one site earns. */
export function flagsFor(site, scale) {
  const flags = [];
  const floor = floorOf(site.role, scale);
  if (site.px < floor) flags.push(site.role === "body" ? "running-text-below-base" : "below-micro");
  if (site.role === "body" && site.tight) flags.push("tight-leading-on-body");
  return flags;
}

/** Every size site in one module or stylesheet. */
export function sitesIn(file, text, { scale, map }) {
  const lines = text.split("\n");
  const out = [];
  const css = file.endsWith(".css");
  lines.forEach((line, i) => {
    const re = css ? SIZE_VAR : SIZE_CLASS;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const step = css ? m[1] : map[m[1]];
      const px = scale.steps[step]?.px;
      if (px === undefined) continue;
      const tag = css ? selectorBefore(lines, i) : tagBefore(lines, i, m.index);
      const classes = css ? "" : line;
      const role = css ? roleOfSelector(tag) : roleOf(tag, classes, file);
      const site = {
        file,
        line: i + 1,
        step,
        px,
        tag,
        role,
        tight: css ? false : LEADING_TIGHT.test(line),
      };
      site.flags = flagsFor(site, scale);
      out.push(site);
    }
  });
  return out;
}

/** The selector a stylesheet declaration belongs to: the nearest line above that opens a block. */
export function selectorBefore(lines, index) {
  for (let i = index; i >= 0; i--) {
    if (/\{\s*$/.test(lines[i])) return lines[i].replace(/\s*\{\s*$/, "").trim();
  }
  return null;
}

/** A stylesheet selector's role: a table cell is body, a header or a term a label. */
export function roleOfSelector(selector) {
  if (!selector) return "unknown";
  if (/\b(th|thead|dt|time|caption|legend)\b/.test(selector) || /label|eyebrow|badge|chip|clock|time/i.test(selector)) return "label";
  if (/\b(td|tbody|dd|p|li|button|input|textarea|select|table)\b/.test(selector)) return "body";
  return "unknown";
}

/* ---------- the tree ---------- */

export function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (SKIP.test(file)) continue;
    if (statSync(file).isDirectory()) listFiles(file, out);
    else if (/\.(tsx|ts|css)$/.test(name)) out.push(file);
  }
  return out;
}

/**
 * The audit over one repository root. `scanDirs` default to the app and the
 * shared UI package; a test passes a fixture tree.
 */
export function audit({
  root = REPO_ROOT,
  scanDirs = ["apps/app/src", "packages/ui/src"],
  tokens = "packages/ui/src/styles/house-tokens.css",
  entry = "apps/app/src/app/globals.css",
  uiStyles = "packages/ui/src/styles",
} = {}) {
  const scale = readScale(readFileSync(join(root, tokens), "utf8"));
  const map = readTailwindMap(join(root, entry), { uiStyles: join(root, uiStyles) });
  const sites = [];
  for (const dir of scanDirs) {
    for (const file of listFiles(join(root, dir))) {
      const rel = relative(root, file);
      sites.push(...sitesIn(rel, readFileSync(file, "utf8"), { scale, map }));
    }
  }
  const histogram = {};
  for (const s of sites) histogram[s.px] = (histogram[s.px] ?? 0) + 1;
  const flagged = sites.filter((s) => s.flags.length > 0);
  const byFlag = {};
  for (const s of flagged) for (const f of s.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
  return { scale, map, sites, histogram, flagged, byFlag, lineBoxes: lineBoxes(scale) };
}

/** Each step's line box (size times leading) and whether it lands on the 4px grid. */
export function lineBoxes(scale) {
  return Object.entries(scale.steps)
    .filter(([name, s]) => name !== "base" && s.leading !== null)
    .map(([name, s]) => {
      const box = round(s.px * s.leading);
      return { step: name, px: s.px, leading: s.leading, box, onGrid: Math.abs(box / 4 - Math.round(box / 4)) < 1e-6 };
    })
    .sort((a, b) => b.px - a.px);
}

/* ---------- the mockup ---------- */

/** The ADR-226 pin: the SHA on the line that reads "The mockup is read at one commit". */
export function readPin(adrText) {
  const m = /read at one commit:[\s\S]*?@\s*([0-9a-f]{7,40})/.exec(adrText);
  return m ? m[1] : null;
}

/** The mockup's font sizes in px at the pin, as `{ px: count }`, and each size's distance to the nearest step. */
export function mockupSizes(dir, pin, scale) {
  const list = execFileSync("git", ["-C", dir, "ls-tree", "--name-only", pin, "mockups/src/"], { encoding: "utf8" });
  const counts = {};
  for (const path of list.split("\n").filter((p) => p.endsWith(".css"))) {
    const css = execFileSync("git", ["-C", dir, "show", `${pin}:${path}`], { encoding: "utf8" });
    for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
      const px = Number(m[1]);
      counts[px] = (counts[px] ?? 0) + 1;
    }
  }
  const stepPx = [...new Set(Object.values(scale.steps).map((s) => s.px))].sort((a, b) => a - b);
  return Object.entries(counts)
    .map(([px, count]) => {
      const n = Number(px);
      const nearest = stepPx.reduce((best, p) => (Math.abs(p - n) < Math.abs(best - n) ? p : best), stepPx[0]);
      return { px: n, count, nearest, error: round(nearest - n) };
    })
    .sort((a, b) => a.px - b.px);
}

/* ---------- the report ---------- */

function round(n) {
  return Math.round(n * 100) / 100;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

export function report(result, mockup) {
  const lines = [];
  lines.push("Type scale at the kit's base");
  for (const [name, s] of Object.entries(result.scale.steps).sort((a, b) => b[1].px - a[1].px)) {
    if (name === "base") continue;
    const tw = Object.entries(result.map).filter(([, step]) => step === name).map(([n]) => `text-${n}`).join(" ");
    lines.push(`  ${pad(name, 6)} ${pad(`${s.px}px`, 7)} ${pad(tw, 10)} leading ${s.leading ?? "-"}`);
  }
  lines.push("");
  lines.push("Line box per step (size times leading)");
  for (const b of result.lineBoxes) {
    lines.push(`  ${pad(b.step, 6)} ${pad(`${b.px}px x ${b.leading}`, 14)} = ${pad(`${b.box}px`, 8)} ${b.onGrid ? "on the 4px grid" : "off the 4px grid"}`);
  }
  lines.push("");
  lines.push(`Sizes in use (${result.sites.length} sites)`);
  for (const [px, count] of Object.entries(result.histogram).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    lines.push(`  ${pad(`${px}px`, 7)} ${pad(count, 6)} ${"#".repeat(Math.min(60, Math.round(count / 10)))}`);
  }
  lines.push("");
  lines.push(`Sites under their role (${result.flagged.length})`);
  for (const [flag, count] of Object.entries(result.byFlag).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${pad(flag, 26)} ${count}`);
  }
  const byFile = {};
  for (const s of result.flagged) (byFile[s.file] ??= []).push(s);
  for (const [file, sites] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${file}`);
    for (const s of sites) {
      lines.push(`    ${pad(`:${s.line}`, 6)} ${pad(`<${s.tag ?? "?"}>`, 10)} ${pad(`${s.px}px`, 6)} ${s.flags.join(", ")}`);
    }
  }
  if (mockup) {
    lines.push("");
    lines.push(`Mockup sizes at the ADR-226 pin ${mockup.pin}, and the nearest step`);
    for (const m of mockup.sizes) {
      const err = m.error === 0 ? "exact" : `${m.error > 0 ? "+" : ""}${m.error}px`;
      lines.push(`  ${pad(`${m.px}px`, 8)} ${pad(`x${m.count}`, 5)} -> ${pad(`${m.nearest}px`, 6)} ${err}`);
    }
  }
  return lines.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const mockupArg = argv[argv.indexOf("--mockup") + 1];
  const result = audit();
  let mockup = null;
  const dir = argv.includes("--mockup") ? resolve(mockupArg) : resolve(REPO_ROOT, "..", "oxagen-roadmap");
  if (existsSync(join(dir, ".git"))) {
    const adr = readFileSync(join(REPO_ROOT, "docs/adr/ADR-226-the-v3-mockup-and-the-brand-kit-are-the-design-of-record.md"), "utf8");
    const pin = readPin(adr);
    if (pin) {
      try {
        mockup = { pin, sizes: mockupSizes(dir, pin, result.scale) };
      } catch (error) {
        process.stderr.write(`mockup skipped: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...result, mockup }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report(result, mockup)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
