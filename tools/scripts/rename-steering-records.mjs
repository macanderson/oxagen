#!/usr/bin/env node
/**
 * rename-steering-records.mjs: the #4325 rename, as a codemod you can rerun.
 *
 * Renames every spelling of the old record name to "steering record" and of
 * the old pull request name to "steering PR": identifiers, capability names,
 * file names, API paths, message keys and values, and prose. It only reads and
 * writes files, and a second run changes nothing.
 *
 *   node tools/scripts/rename-steering-records.mjs          rewrite the tree
 *   node tools/scripts/rename-steering-records.mjs --check  exit 1 if a run would change a file
 *   node tools/scripts/rename-steering-records.mjs --plan   print each rule's matches and the
 *                                                           identifiers the rename would collide with
 *
 * It leaves alone: applied migrations, the pre-Atlas migration archive, ADR
 * history, release notes, the agent memory folder, and three kinds of token
 * that name something outside this rename: an applied migration's file name,
 * an ADR's file name, and Stella's record file format tag. Other senses of
 * "context" (the context graph, context frames, context_precision) never
 * match a rule.
 *
 * Run it from the repository root. It is removed once #4325 merges.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const argv = new Set(process.argv.slice(2));
const CHECK = argv.has("--check");
const PLAN = argv.has("--plan");

const INCLUDE = [
  /^apps\//,
  /^packages\//,
  /^docs\//,
  /^tools\//,
  /^\.claude\/(?:commands|skills|agents)\//,
  /^(?:AGENTS|CLAUDE|DEREGISTERED|README|CONTRIBUTING)\.md$/,
];

const EXCLUDE = [
  /^packages\/database\/atlas\/migrations\//,
  /^packages\/database\/drizzle\//,
  /^docs\/adr\//,
  /^apps\/docs\/content\/docs\/releases\//,
  /^tools\/scripts\/rename-steering-records\.mjs$/,
  /(?:^|\/)node_modules\//,
];

const TEXT =
  /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonc|md|mdx|sql|toml|ya?ml|txt|html|css|sh|hcl|snap|csv)$/;

// Tokens that name something this rename does not own. Each is swapped for a
// placeholder before the rules run and restored after.
const PROTECT = [
  // Stella's record file format; Stella renames it in its own repository.
  /context-record\/v\d[\w.]*/g,
  // An applied migration's name, which never changes.
  /\b\d{14}_[a-z0-9_]+/g,
  // An ADR's file name. ADR history keeps its words.
  /\bADR-\d{3}-[a-z0-9-]+/g,
];

const lower = (s) => s.toLowerCase();

/** Code and path rules. They run on file paths and on file contents. */
const CODE_RULES = [
  // snake_case and SCREAMING_SNAKE
  { id: "snake-record", re: /context_record/g, to: "steering_record" },
  { id: "upper-record", re: /CONTEXT_RECORD/g, to: "STEERING_RECORD" },
  { id: "snake-pr", re: /context_pr(s?)(?![a-z])/g, to: "steering_pr$1" },
  { id: "upper-pr", re: /CONTEXT_PR(S?)(?![A-Z])/g, to: "STEERING_PR$1" },
  { id: "snake-proposal", re: /context_proposal/g, to: "steering_proposal" },
  { id: "snake-promotion", re: /context_promotion/g, to: "steering_promotion" },
  { id: "upper-proposal", re: /CONTEXT_PROPOSAL/g, to: "STEERING_PROPOSAL" },
  { id: "upper-promotion", re: /CONTEXT_PROMOTION/g, to: "STEERING_PROMOTION" },
  // camelCase and PascalCase
  { id: "camel-record", re: /contextRecord/g, to: "steeringRecord" },
  { id: "pascal-record", re: /ContextRecord/g, to: "SteeringRecord" },
  { id: "camel-pr", re: /contextPr(s?)(?![a-z])/g, to: "steeringPr$1" },
  { id: "pascal-pr", re: /ContextPr(s?)(?![a-z])/g, to: "SteeringPr$1" },
  { id: "camel-proposal", re: /contextProposal/g, to: "steeringProposal" },
  { id: "pascal-proposal", re: /ContextProposal/g, to: "SteeringProposal" },
  { id: "camel-promotion", re: /contextPromotion/g, to: "steeringPromotion" },
  { id: "pascal-promotion", re: /ContextPromotion/g, to: "SteeringPromotion" },
  // kebab-case
  { id: "kebab-record", re: /context-record/g, to: "steering-record" },
  { id: "kebab-pr", re: /context-pr(s?)(?![a-z])/g, to: "steering-pr$1" },
  { id: "kebab-proposal", re: /context-proposal/g, to: "steering-proposal" },
  // dotted file stems: context.record.publish, context.pr.merge
  {
    id: "dotted-stem",
    re: /\bcontext\.(records?|prs?|proposals?)(?![a-z])/g,
    to: "steering.$1",
  },
  // API paths: /context/record/publish, /context/prs/merge
  {
    id: "api-path",
    re: /\/context\/(records?|prs?|proposals?)(?![a-z])/g,
    to: "/steering/$1",
  },
];

// Between the two words of a name: spaces, or a line break that may carry a
// comment marker or a block quote.
const SEP = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*(?:(?:\/\/|\*|#|--|>)[ \t]*)?)`;

/**
 * Whether the word at `index` opens a sentence, a heading, a label or a
 * string, so "Context PR" there becomes "Steering PR" and elsewhere
 * "steering PR".
 */
function opensSentence(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  const trimmed = prefix.trim();
  if (trimmed !== "" && !/^(?:\/\/|\*|--|>)$/.test(trimmed)) {
    if (/^(?:#+|[-*+]|\d+\.|\|)$/.test(trimmed)) return true;
    const last = trimmed[trimmed.length - 1];
    return !/[a-z0-9,(/:'\-–]/.test(last);
  }
  // At the start of a line: read the end of the line before it.
  if (lineStart === 0) return true;
  const before = text.slice(0, lineStart - 1).trimEnd();
  const prevLine = before.slice(before.lastIndexOf("\n") + 1).trim();
  const content = prevLine.replace(/^(?:\/\/|\*|--|>|#+)\s*/, "");
  if (content === "") return true;
  const last = content[content.length - 1];
  return !/[a-z0-9,(]/.test(last);
}

/** Prose rules. They run on file contents only. */
const WORD_RULES = [
  {
    id: "words-record",
    re: new RegExp(String.raw`\b([Cc])ontext(${SEP})(records?)\b`, "g"),
    to: (_m, c, sep, rec) => `${c === "C" ? "S" : "s"}teering${sep}${rec}`,
  },
  {
    id: "words-record-title",
    re: new RegExp(String.raw`\bContext(${SEP})(Records?)\b`, "g"),
    to: (_m, sep, rec) => `Steering${sep}${rec}`,
  },
  {
    id: "words-record-upper",
    re: new RegExp(String.raw`\bCONTEXT(${SEP})(RECORDS?)\b`, "g"),
    to: (_m, sep, rec) => `STEERING${sep}${rec}`,
  },
  {
    id: "words-pr",
    re: new RegExp(String.raw`\b([Cc])ontext(${SEP})(PRs?)\b`, "g"),
    to: (_m, c, sep, pr, offset, text) =>
      `${c === "C" && opensSentence(text, offset) ? "S" : "s"}teering${sep}${pr}`,
  },
  {
    id: "words-pr-upper",
    re: new RegExp(String.raw`\bCONTEXT(${SEP})(PRS?)\b`, "g"),
    to: (_m, sep, pr) => `STEERING${sep}${pr}`,
  },
];

function protect(text) {
  const saved = [];
  let out = text;
  for (const re of PROTECT) {
    out = out.replace(re, (m) => {
      saved.push(m);
      return `\u0000${saved.length - 1}\u0000`;
    });
  }
  return { out, saved };
}

function restore(text, saved) {
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => saved[Number(i)]);
}

const stats = new Map();
function count(id, m) {
  const entry = stats.get(id) ?? { n: 0, samples: new Map() };
  entry.n += 1;
  entry.samples.set(m, (entry.samples.get(m) ?? 0) + 1);
  stats.set(id, entry);
}

function apply(text, rules) {
  const { out, saved } = protect(text);
  let next = out;
  for (const rule of rules) {
    next = next.replace(rule.re, (...args) => {
      const m = args[0];
      count(rule.id, m.replace(/\s+/g, " "));
      if (typeof rule.to === "function") return rule.to(...args);
      return m.replace(new RegExp(rule.re.source), rule.to);
    });
  }
  return restore(next, saved);
}

function trackedFiles() {
  const raw = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return raw
    .split("\0")
    .filter(Boolean)
    .filter((p) => INCLUDE.some((re) => re.test(p)))
    .filter((p) => !EXCLUDE.some((re) => re.test(p)))
    .filter((p) => existsSync(join(ROOT, p)));
}

const IDENT = /[A-Za-z0-9_$]+/g;

/** Every identifier a rename produces that the tree already holds. */
function collisions(files, contents) {
  const pairs = new Map();
  for (const [file, text] of contents) {
    for (const m of text.matchAll(IDENT)) {
      if (!/context/i.test(m[0])) continue;
      const next = apply(m[0], CODE_RULES);
      if (next === m[0]) continue;
      const set = pairs.get(m[0]) ?? { to: next, files: new Set() };
      set.files.add(file);
      pairs.set(m[0], set);
    }
  }
  const existing = new Map();
  for (const [file, text] of contents) {
    for (const m of text.matchAll(IDENT)) {
      if (!/steering/i.test(m[0])) continue;
      const set = existing.get(m[0]);
      if (set) set.add(file);
      else existing.set(m[0], new Set([file]));
    }
  }
  const found = [];
  for (const [from, { to, files: fromFiles }] of pairs) {
    const holders = existing.get(to);
    if (!holders) continue;
    const both = [...fromFiles].filter((f) => holders.has(f));
    found.push({ from, to, both, holders: holders.size });
  }
  return found.sort((a, b) => b.both.length - a.both.length);
}

function main() {
  const files = trackedFiles();
  const contents = new Map();
  for (const file of files) {
    if (!TEXT.test(file)) continue;
    contents.set(file, readFileSync(join(ROOT, file), "utf8"));
  }

  if (PLAN) {
    for (const found of collisions(files, contents)) {
      console.log(
        `collision ${found.from} -> ${found.to}: ${found.holders} file(s) already hold it` +
          (found.both.length ? `; both in ${found.both.join(", ")}` : ""),
      );
    }
    stats.clear();
  }

  const renames = [];
  for (const file of files) {
    const next = apply(file, CODE_RULES);
    if (next !== file) renames.push([file, next]);
  }
  const writes = [];
  for (const [file, text] of contents) {
    const next = apply(text, [...CODE_RULES, ...WORD_RULES]);
    if (next !== text) writes.push([file, next]);
  }

  if (PLAN) {
    for (const [id, { n, samples }] of stats) {
      const top = [...samples.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([s, k]) => `${s} (${k})`)
        .join(", ");
      console.log(`rule ${id}: ${n} match(es): ${top}`);
    }
    for (const [from, to] of renames) console.log(`rename ${from} -> ${to}`);
    console.log(`${writes.length} file(s) to rewrite, ${renames.length} to rename`);
    return;
  }

  if (CHECK) {
    if (writes.length || renames.length) {
      console.error(
        `${writes.length} file(s) still need a rewrite and ${renames.length} a rename`,
      );
      for (const [file] of writes) console.error(`  rewrite ${file}`);
      for (const [from, to] of renames) console.error(`  rename ${from} -> ${to}`);
      process.exit(1);
    }
    console.log("Nothing to rename.");
    return;
  }

  for (const [file, text] of writes) writeFileSync(join(ROOT, file), text);
  for (const [from, to] of renames) {
    if (existsSync(join(ROOT, to))) {
      console.error(`refusing to rename ${from}: ${to} already exists`);
      process.exitCode = 1;
      continue;
    }
    mkdirSync(dirname(join(ROOT, to)), { recursive: true });
    execFileSync("git", ["mv", from, to], { cwd: ROOT });
  }
  console.log(
    `Rewrote ${writes.length} file(s) and renamed ${renames.length}.`,
  );
}

main();
