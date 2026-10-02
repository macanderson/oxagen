#!/usr/bin/env node
/**
 * check-tacho-commands.mjs: no user-facing string tells a person to type a
 * `tacho` command (#4879).
 *
 * The recorder's commands moved into the `oxagen` CLI: `oxagen agent enroll`,
 * `oxagen agent status`, `oxagen agent run`, and the rest. `tacho`, `tachod`,
 * and `tacho-hook` stay as hidden aliases for machines enrolled before the
 * move, so nothing breaks when an old string survives. That is why this guard
 * exists: a stale instruction keeps working, so nothing else would catch it.
 *
 * What it reads:
 *
 *   - the string literals, template text, and JSX text of the CLI
 *     (`apps/cli/src`), the recorder (`packages/tacho/src`), and the desktop
 *     app (`apps/desktop/src`), test files left out. Comments are not read: a
 *     comment may name the old command to explain an alias.
 *   - every line of the CLI docs, the docs site (`apps/docs/content`, release
 *     notes left out, since each records what shipped then), `AGENTS.md`,
 *     the READMEs and guides that document these commands, the web app's
 *     message catalogues, and the website (`apps/web`, its commit-history
 *     page left out). `CLAUDE.md` is left out because its issue-label table
 *     names the `tacho` area label, which is not a command.
 *
 * What it flags: a `tacho`, `tachod`, or `tacho-hook` command, which is the
 * executable followed by one of its verbs (`tacho enroll`), a code span or
 * an HTML `<code>` element that starts with the executable (`` `tacho-hook` ``),
 * or an argv that names it (`["tacho", "hook"]`). The word on its own is not flagged: the recorder's
 * directory, its wire format, and its database tables keep the name.
 *
 * The aliases have to spell the old names to say what replaced them. A
 * string whose line, or the line before it, carries the comment
 * `tacho-command-check: alias` is allowed.
 *
 * Exit codes:
 *   0: no user-facing string names a tacho command.
 *   1: one or more do; each is printed as path:line with the text.
 *   2: script error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

/** Source trees whose strings a person reads, as help, output, or UI copy. */
export const SOURCE_ROOTS = [
  "apps/cli/src/",
  "packages/tacho/src/",
  "apps/desktop/src/",
];

/** Documents a person reads, by exact path. */
export const PROSE_FILES = [
  "AGENTS.md",
  "apps/cli/README.md",
  "apps/desktop/README.md",
  "packages/tacho/README.md",
];

/** Document trees a person reads, each with the files in it that are prose. */
export const PROSE_ROOTS = [
  { root: "apps/docs/content/", files: /\.mdx?$/ },
  { root: "docs/guides/", files: /\.md$/ },
  { root: "docs/reference/", files: /\.md$/ },
  { root: "apps/app/messages/", files: /\.json$/ },
  { root: "apps/web/", files: /\.(?:html|mdx?)$/ },
];

/**
 * Release notes record what shipped at the time, old names included, and the
 * website's story page charts commit history.
 */
export const PROSE_EXCLUDED = [
  "apps/docs/content/docs/releases/",
  "apps/web/story/",
  "apps/web/dist/",
];

/** The comment that allows one string to name an old command. */
export const ALLOW_MARKER = "tacho-command-check: alias";

const VERBS = [
  "enroll",
  "status",
  "unenroll",
  "uninstall",
  "reassign",
  "export",
  "verify",
  "hosts",
  "run",
  "detect",
  "daemon",
  "hook",
  "mcp-stdio",
  "arp",
  "credential\\s+(?:issue|status)",
  "github\\s+(?:configure|credential)",
].join("|");

/**
 * The shapes of an instruction to type a tacho command. Each pattern is
 * tested on its own, so one with the global flag never carries state.
 */
export const TACHO_COMMAND_PATTERNS = [
  // `tacho enroll`, `oxagen tacho status`, `tacho-hook hook`, `".../tacho" unenroll`.
  new RegExp(`\\btacho(?:-hook)?["']?\\s+(?:${VERBS})\\b`),
  // A code span that starts with the executable: `tacho`, `tachod --x`.
  /`(?:oxagen\s+)?(?:tacho|tachod|tacho-hook)(?=[\s`])[^`\n]*`/,
  // The same in HTML: <code>tacho hook</code>.
  /<code>(?:oxagen\s+)?(?:tacho|tachod|tacho-hook)(?=[\s<])/,
  // An argv: ["tacho", "hook"], spawnSync("tacho", ["hook", ...]).
  new RegExp(
    `["'](?:tacho|tachod|tacho-hook)["']\\s*,\\s*\\[?\\s*["'](?:${VERBS})["']`,
  ),
];

/** Whether `text` tells a person to type a tacho command. */
export function namesTachoCommand(text) {
  return TACHO_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

function isTestFile(path) {
  return /\.test\.[cm]?[jt]sx?$|\/__tests__\//.test(path);
}

/** Whether `path` is a source file this guard reads. */
export function isScannedSource(path) {
  return (
    SOURCE_ROOTS.some((root) => path.startsWith(root)) &&
    /\.[cm]?tsx?$/.test(path) &&
    !path.endsWith(".d.ts") &&
    !isTestFile(path)
  );
}

/** Whether `path` is a document this guard reads. */
export function isScannedProse(path) {
  if (PROSE_FILES.includes(path)) return true;
  return (
    PROSE_ROOTS.some(({ root, files }) => path.startsWith(root) && files.test(path)) &&
    !PROSE_EXCLUDED.some((root) => path.startsWith(root))
  );
}

/**
 * Every string a person could read in a TypeScript source, with the line it
 * starts on: string literals, the text of template literals, and JSX text.
 */
export function stringsIn(path, source) {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const found = [];
  const add = (node, text) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push({ line: line + 1, text });
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      add(node, node.text);
    else if (ts.isTemplateExpression(node))
      // The text around each substitution, read as one line so a command
      // split by a `${}` is still seen: `tacho ${verb}` reads as "tacho  ".
      add(
        node,
        [
          node.head.text,
          ...node.templateSpans.map((span) => ` ${span.literal.text}`),
        ].join(""),
      );
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The findings in one file: `{ line, text }` for each string that names a tacho command. */
export function findTachoCommands(path, contents) {
  const lines = contents.split("\n");
  const allowed = (line) =>
    (lines[line - 1] ?? "").includes(ALLOW_MARKER) ||
    (lines[line - 2] ?? "").includes(ALLOW_MARKER);
  if (isScannedSource(path))
    return stringsIn(path, contents).filter(
      ({ line, text }) => namesTachoCommand(text) && !allowed(line),
    );
  return lines
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ line, text }) => namesTachoCommand(text) && !allowed(line));
}

/** The part of `text` that names the command, on one line. */
export function excerpt(text) {
  const flat = text.replace(/\s+/g, " ");
  const at = Math.min(
    ...TACHO_COMMAND_PATTERNS.map((pattern) => {
      const match = pattern.exec(flat);
      return match === null ? flat.length : match.index;
    }),
  );
  const start = Math.max(0, at - 40);
  return `${start > 0 ? "…" : ""}${flat.slice(start, at + 80).trim()}`;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path.length > 0);
}

function main() {
  const findings = [];
  for (const path of trackedFiles()) {
    if (!isScannedSource(path) && !isScannedProse(path)) continue;
    let contents;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      // A tracked path missing from the working tree is not this guard's.
      continue;
    }
    for (const finding of findTachoCommands(path, contents))
      findings.push({ path, ...finding });
  }
  if (findings.length === 0) {
    console.log(
      "check-tacho-commands: no user-facing string names a tacho command",
    );
    return 0;
  }
  console.error(
    "These user-facing strings tell a person to type a tacho command. Name the oxagen command that replaced it (`oxagen agent enroll`, `oxagen agent status`, `oxagen hook`, and so on; see OXAGEN_COMMAND_FOR in packages/tacho/src/cli/alias.ts):\n",
  );
  for (const { path, line, text } of findings)
    console.error(`  ${path}:${line}  ${excerpt(text)}`);
  console.error(`\n${findings.length} found.`);
  return 1;
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `check-tacho-commands: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
