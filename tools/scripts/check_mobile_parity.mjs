#!/usr/bin/env node
/**
 * check_mobile_parity.mjs — enforce the "Mobile Feature Parity" law (ADR-026).
 *
 * Sibling to check_ui_parity.mjs. Where check_ui_parity verifies a capability
 * has a WORKING page in apps/app at all, this verifies the page doesn't then
 * turn around and hide the capability from mobile viewports with a Tailwind
 * responsive-display utility. The product law: mobile must have every
 * desktop feature. Hiding a feature from mobile requires a registered,
 * strong justification — the only acceptable categories are "security" and
 * "performance" (outsized cost relative to the feature's value). Re-presenting
 * a feature differently on mobile ("reflow") is fine but must be declared
 * with a description of the equivalent mobile surface.
 *
 * Detection scans apps/app/src for two Tailwind patterns inside a single
 * string/template literal:
 *
 *   type A — a standalone `hidden` class token alongside a token that makes
 *            the element visible again at sm/md/lg/xl/2xl (e.g.
 *            `hidden md:block`). This is the classic "desktop reveals it,
 *            mobile never sees it" shape.
 *   type B — a `max-{sm,md,lg,xl,2xl}:hidden` token — the inverse shape,
 *            hidden above a max-width breakpoint (i.e. hidden ON mobile).
 *
 * Every finding must be covered by an entry in apps/app/mobile-parity.json
 * (matched by file + a literal substring). An entry is either:
 *   kind: "reflow" — the feature is re-presented on mobile; requires
 *         `equivalent` (>=20 chars) describing the mobile-equivalent surface.
 *   kind: "hidden" — the feature is genuinely unavailable on mobile; requires
 *         `reason` ("security" | "performance"), `justification` (>=120
 *         chars), and `approvedBy`.
 *
 * Manifest hygiene is enforced both ways: an uncovered finding is a
 * violation, and so is a manifest entry that covers nothing (stale — forces
 * the manifest to track reality, not accumulate dead registrations). An
 * entry may set `pending: true` to register ahead of an in-flight change
 * that hasn't landed yet on this branch; that suppresses the stale violation
 * but still emits a `::warning::` so it doesn't go unnoticed forever.
 *
 * Output modes (match check_ui_parity.mjs):
 *   (default)    ENFORCING — violations print as ::error:: annotations,
 *                exit 1.
 *   --warn-only  violations print as ::warning:: annotations, exit 0.
 *   --json       emit { findings, violations, entries } to stdout, exit 0.
 *
 * A structural error (no apps/app/src, unparseable manifest) hard-fails
 * (exit 2) — that's a broken repo, not an incomplete feature.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has("--json");
const WARN_ONLY = ARGS.has("--warn-only");
const info = JSON_MODE ? () => {} : (...a) => console.log(...a);

const ROOT = resolve(process.cwd());
const APP_SRC = join(ROOT, "apps/app/src");
const MANIFEST = join(ROOT, "apps/app/mobile-parity.json");

// ── Detection ────────────────────────────────────────────────────────────────
const VISIBLE_AT_BREAKPOINT_RE =
  /^(sm|md|lg|xl|2xl):(block|flex|grid|inline|inline-flex|inline-block|table|table-cell|table-row|contents|list-item)$/;
const MAX_HIDDEN_RE = /^max-(sm|md|lg|xl|2xl):hidden$/;

/**
 * Tokenize source into string/template literals, skipping `//` and `/* *\/`
 * comments entirely.
 *
 * A naive `"[^"]*"|'[^']*'` alternation regex desyncs on this codebase's
 * heavy JSDoc commenting style: an apostrophe in a comment like "the
 * layout's critical path" opens a bogus single-quoted "string" that swallows
 * everything up to the next apostrophe — silently eating real literals in
 * between (false negatives) and, in reverse, matching an example snippet
 * quoted inside a docblock as if it were live code (false positives, as seen
 * in settings-nav.tsx's usage-example comment). Comments carry no runtime
 * Tailwind classes, so excluding them outright is strictly more correct.
 *
 * @param {string} content
 * @returns {Array<{value:string, line:number}>}
 */
export function scanStringLiterals(content) {
  const literals = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  const advance = () => {
    if (content[i] === "\n") line++;
    i++;
  };
  while (i < n) {
    const c = content[i];
    const c2 = i + 1 < n ? content[i + 1] : "";
    if (c === "/" && c2 === "/") {
      while (i < n && content[i] !== "\n") advance();
      continue;
    }
    if (c === "/" && c2 === "*") {
      advance();
      advance();
      while (i < n && !(content[i] === "*" && content[i + 1] === "/"))
        advance();
      if (i < n) {
        advance();
        advance();
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const startLine = line;
      let value = "";
      advance(); // past opening quote
      while (i < n && content[i] !== quote) {
        if (content[i] === "\\" && i + 1 < n) {
          value += content[i + 1];
          advance();
          advance();
          continue;
        }
        value += content[i];
        advance();
      }
      if (i < n) advance(); // past closing quote
      literals.push({ value, line: startLine });
      continue;
    }
    advance();
  }
  return literals;
}

/**
 * Scan one file's source for desktop-only hiding patterns inside string/
 * template literals. Pure — takes source text, not a path on disk — so tests
 * can exercise it directly.
 *
 * @param {string} content
 * @param {string} filePath - repo-relative path, used only to label findings
 * @returns {Array<{file:string, line:number, literal:string, type:"A"|"B"}>}
 */
export function extractFindings(content, filePath) {
  const findings = [];
  for (const { value: literal, line } of scanStringLiterals(content)) {
    if (!literal.includes("hidden")) continue;
    const tokens = literal.split(/\s+/).filter(Boolean);
    const hasHiddenToken = tokens.includes("hidden");
    const hasVisibleAtBreakpoint = tokens.some((t) =>
      VISIBLE_AT_BREAKPOINT_RE.test(t),
    );
    const hasMaxHidden = tokens.some((t) => MAX_HIDDEN_RE.test(t));
    if (!(hasHiddenToken && hasVisibleAtBreakpoint) && !hasMaxHidden) continue;
    if (hasHiddenToken && hasVisibleAtBreakpoint) {
      findings.push({ file: filePath, line, literal, type: "A" });
    }
    if (hasMaxHidden) {
      findings.push({ file: filePath, line, literal, type: "B" });
    }
  }
  return findings;
}

// ── Manifest compliance (pure) ──────────────────────────────────────────────
const VALID_HIDDEN_REASONS = new Set(["security", "performance"]);

/**
 * @typedef {{file:string, line:number, literal:string, type:"A"|"B"}} Finding
 * @typedef {{
 *   file: string, match: string, kind: "reflow"|"hidden",
 *   equivalent?: string, reason?: string, justification?: string,
 *   approvedBy?: string, pending?: boolean,
 * }} ManifestEntry
 */

/**
 * Compute violations + advisory warnings from findings and the manifest.
 * Pure — no disk access — so tests can exercise it directly.
 *
 * @param {Finding[]} findings
 * @param {{entries: ManifestEntry[]}} manifest
 */
export function computeMobileParity(findings, manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const violations = [];
  const warnings = [];

  // Structural validation of each entry, independent of coverage.
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !entry.file ||
      !entry.match ||
      !entry.kind
    ) {
      violations.push({
        type: "invalid-entry",
        entry,
        reason: "entry is missing required file/match/kind",
      });
      continue;
    }
    if (entry.kind === "hidden") {
      if (!VALID_HIDDEN_REASONS.has(entry.reason)) {
        violations.push({
          type: "invalid-hidden-reason",
          entry,
          reason: `reason must be "security" or "performance", got ${JSON.stringify(entry.reason ?? null)}`,
        });
      }
      if (!entry.justification || entry.justification.length < 120) {
        violations.push({
          type: "invalid-hidden-justification",
          entry,
          reason: `justification must be >= 120 chars (got ${entry.justification?.length ?? 0})`,
        });
      }
      if (!entry.approvedBy) {
        violations.push({
          type: "invalid-hidden-approval",
          entry,
          reason: "approvedBy is required for kind=hidden",
        });
      }
    } else if (entry.kind === "reflow") {
      if (!entry.equivalent || entry.equivalent.length < 20) {
        violations.push({
          type: "invalid-reflow-equivalent",
          entry,
          reason: `equivalent must be >= 20 chars describing the mobile surface (got ${entry.equivalent?.length ?? 0})`,
        });
      }
    } else {
      violations.push({
        type: "invalid-entry-kind",
        entry,
        reason: `kind must be "reflow" or "hidden", got ${JSON.stringify(entry.kind)}`,
      });
    }
  }

  // Coverage: every finding must be matched by some entry (file + substring).
  const coveredEntryIndexes = new Set();
  for (const finding of findings) {
    const idx = entries.findIndex(
      (e) =>
        e &&
        e.file === finding.file &&
        typeof e.match === "string" &&
        finding.literal.includes(e.match),
    );
    if (idx === -1) {
      violations.push({
        type: "uncovered-finding",
        finding,
        reason:
          "flagged mobile-hiding pattern is not registered in apps/app/mobile-parity.json",
      });
    } else {
      coveredEntryIndexes.add(idx);
    }
  }

  // Stale entries: registered but match nothing on this scan. `pending`
  // entries are exempted (registered ahead of an in-flight change) but still
  // surfaced as a warning so they can't silently rot forever.
  entries.forEach((entry, idx) => {
    if (coveredEntryIndexes.has(idx)) return;
    if (entry && entry.pending) {
      warnings.push({
        type: "pending-entry",
        entry,
        reason:
          "registered ahead of an in-flight change — not yet matched by a finding",
      });
    } else {
      violations.push({
        type: "stale-entry",
        entry,
        reason:
          "entry does not match any current finding — remove it or fix the match",
      });
    }
  });

  return { violations, warnings };
}

// ── Filesystem scanning ──────────────────────────────────────────────────────
function shouldSkip(absPath) {
  return (
    absPath.endsWith(".test.tsx") || absPath.includes(`${sep}__tests__${sep}`)
  );
}

function listTsxFiles() {
  try {
    const out = execFileSync("rg", ["--files", "-g", "*.tsx", APP_SRC], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return walkTsxFiles(APP_SRC);
  }
}

function walkTsxFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
  }
  return out;
}

function collectFindings() {
  const files = listTsxFiles().filter((f) => !shouldSkip(f));
  const findings = [];
  for (const abs of files) {
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = relative(ROOT, abs);
    findings.push(...extractFindings(content, rel));
  }
  return findings;
}

function readManifest() {
  if (!existsSync(MANIFEST)) {
    console.error(`No mobile-parity manifest at ${MANIFEST}.`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    console.error(`mobile-parity.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    console.error(`mobile-parity.json is missing an "entries" array.`);
    process.exit(2);
  }
  return parsed;
}

// ── Reporting ────────────────────────────────────────────────────────────────
function describeEntry(entry) {
  return `${entry?.file ?? "(unknown file)"} (match ${JSON.stringify(entry?.match ?? "")})`;
}

function describeViolation(v) {
  switch (v.type) {
    case "uncovered-finding":
      return `${v.finding.file}:${v.finding.line} — unregistered ${v.finding.type === "B" ? "mobile-hidden" : "desktop-only"} pattern \`${v.finding.literal}\` — ${v.reason}`;
    case "stale-entry":
      return `${describeEntry(v.entry)} — ${v.reason}`;
    default:
      return `${describeEntry(v.entry)} — ${v.reason}`;
  }
}

function main() {
  if (!existsSync(APP_SRC)) {
    console.error(`No apps/app/src at ${APP_SRC}.`);
    process.exit(2);
  }
  const manifest = readManifest();
  const findings = collectFindings();
  const { violations, warnings } = computeMobileParity(findings, manifest);

  if (JSON_MODE) {
    process.stdout.write(
      JSON.stringify(
        { findings, violations, entries: manifest.entries },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  info(
    `Mobile parity: ${findings.length} finding(s) scanned, ${manifest.entries.length} manifest entrie(s), ${violations.length} violation(s).`,
  );

  for (const w of warnings) {
    console.log(
      `::warning title=Mobile parity (pending)::${describeEntry(w.entry)} — ${w.reason}`,
    );
  }

  if (!violations.length) {
    info(
      "Mobile Feature Parity: every desktop-only pattern is covered by a registered, valid manifest entry.",
    );
    return;
  }

  const annotation = WARN_ONLY ? "warning" : "error";
  for (const v of violations) {
    console.log(
      `::${annotation} title=Mobile parity violation::${describeViolation(v)}`,
    );
  }
  console.error(`\nMOBILE PARITY VIOLATIONS — ${violations.length}:`);
  for (const v of violations) console.error(`  - ${describeViolation(v)}`);
  console.error(
    "\nMobile is not a second-class surface — every desktop capability must work on mobile (ADR-026). For each" +
      "\nviolation above, either:" +
      "\n  1) make the feature available on mobile (preferred — drop the hiding class), or" +
      '\n  2) if this is a genuine reflow, register a kind="reflow" entry in apps/app/mobile-parity.json describing' +
      "\n     the mobile-equivalent surface (>=20 chars), or" +
      '\n  3) if hiding is truly required, register a kind="hidden" entry with a security/performance reason, a' +
      "\n     >=120 char justification, and an approvedBy.",
  );

  if (WARN_ONLY) {
    console.error(
      "\n--warn-only: not failing the build, but fix this before merge.",
    );
    return;
  }
  process.exit(1);
}

// Only run when executed directly (not when imported by the test).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
