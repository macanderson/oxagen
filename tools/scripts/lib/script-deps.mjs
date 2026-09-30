/**
 * What a root script or a git hook needs installed before it can run.
 *
 * The root `package.json` and `lefthook.yml` run files under `tools/scripts/`
 * with `node` and `tsx`, from the repository root. Those files import
 * workspace packages (`@oxagen/oxagen`, `@oxagen/config`) and a few npm
 * packages. A full `pnpm install` makes them resolvable through
 * `tools/scripts/node_modules`, because `@oxagen/scripts` declares them. A
 * filtered install that leaves `@oxagen/scripts` out does not, and the check
 * then dies on a module-resolution error that reads like a failed check
 * (#3403).
 *
 * Two callers share this module:
 *
 *   - `tools/scripts/hook-preflight.mjs` asks, at hook time, whether each
 *     import is installed, and says plainly that the check could not run when
 *     one is not.
 *   - `tools/scripts/root-hook-deps.test.ts` asks, in CI, whether each import
 *     is declared in the root `package.json`, so the sweep #3403 asked for
 *     keeps holding after it lands.
 *
 * Everything here is pure over injected `read` and `exists` functions, apart
 * from the TypeScript parser the caller passes in.
 */
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const BUILTINS = new Set(builtinModules);
const SCRIPT_FILE = /\.(mjs|cjs|js|ts|mts|cts)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RUN_CHECKS = /(^|\/)run-checks\.mjs$/;

/**
 * Split a shell command into the simple commands it chains. Quotes are not
 * interpreted: the commands this reads are package.json scripts and lefthook
 * `run:` lines, which chain with `&&`, `||`, `;` and `|` and quote nothing
 * that holds those characters.
 *
 * @param {string} command
 * @returns {string[][]} one token list per simple command
 */
export function simpleCommands(command) {
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) => {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      // A leading `FOO=bar` sets the environment for the command after it.
      while (tokens.length > 0 && ENV_ASSIGNMENT.test(tokens[0]))
        tokens.shift();
      return tokens;
    })
    .filter((tokens) => tokens.length > 0);
}

/**
 * The simple commands a command runs once every `pnpm <script>` is replaced
 * by the root script it names. A script is expanded once, so a script that
 * names itself cannot loop.
 *
 * `node tools/scripts/run-checks.mjs a b` runs `pnpm run a` and then
 * `pnpm run b`, so each name after the runner expands the same way, after
 * the runner's own command. `check:contracts` is such a list, and without
 * this the pre-push preflight would see only the runner and miss every
 * package its guards import.
 *
 * @param {string} command
 * @param {Record<string, string>} scripts the root package.json `scripts`
 * @returns {string[][]}
 */
export function expandCommand(command, scripts, seen = new Set()) {
  const out = [];
  for (const tokens of simpleCommands(command)) {
    const [head, ...rest] = tokens;
    if (head === "node" && rest.length > 0 && RUN_CHECKS.test(rest[0])) {
      out.push(tokens);
      for (const listed of rest.slice(1)) {
        if (scripts[listed] === undefined || seen.has(listed)) continue;
        seen.add(listed);
        out.push(...expandCommand(scripts[listed], scripts, seen));
      }
      continue;
    }
    const name =
      head === "pnpm" ? (rest[0] === "run" ? rest[1] : rest[0]) : undefined;
    if (name && !name.startsWith("-") && scripts[name] !== undefined) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(...expandCommand(scripts[name], scripts, seen));
      }
      continue;
    }
    out.push(tokens);
  }
  return out;
}

/**
 * The script files a command runs from the repository root, following
 * `pnpm <script>` into the root `package.json`.
 *
 * Only `node <file>`, `tsx <file>` and `npx tsx <file>` count as an entry.
 * `pnpm --filter`, `pnpm exec`, `cd`, `bash`, `turbo` and the like run inside
 * another package, or run a binary, so what they import is that package's
 * business and not the root's.
 *
 * @param {string} command
 * @param {Record<string, string>} scripts the root package.json `scripts`
 * @returns {string[]} repo-relative entry paths, in first-seen order
 */
export function entriesOf(command, scripts) {
  const entries = [];
  for (const tokens of expandCommand(command, scripts)) {
    const [head, ...rest] =
      tokens[0] === "npx" && tokens[1] === "tsx" ? tokens.slice(1) : tokens;
    if (head !== "node" && head !== "tsx") continue;
    const file = rest.find((t) => !t.startsWith("-") && SCRIPT_FILE.test(t));
    if (file && !entries.includes(file)) entries.push(file);
  }
  return entries;
}

/**
 * Whether a command runs anything under `tsx`, which then has to be installed
 * at the root.
 *
 * @param {string} command
 * @param {Record<string, string>} scripts
 */
export function usesTsx(command, scripts) {
  return expandCommand(command, scripts).some(
    (tokens) =>
      tokens[0] === "tsx" || (tokens[0] === "npx" && tokens[1] === "tsx"),
  );
}

/**
 * The package a bare specifier names: `@scope/name` or `name`, without the
 * subpath. `@oxagen/config/env` is `@oxagen/config`.
 *
 * @param {string} specifier
 * @returns {string}
 */
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Whether a specifier is a Node built-in (`node:fs`, `fs`, `fs/promises`).
 *
 * @param {string} specifier
 */
export function isBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0]);
}

/**
 * The module specifiers a file loads at run time. Type-only imports and
 * exports are left out, because `tsx` erases them and nothing has to be
 * installed for them.
 *
 * @param {string} source
 * @param {string} fileName used for the parser's script kind
 * @param {typeof import("typescript")} ts
 * @returns {string[]}
 */
export function runtimeSpecifiers(source, fileName, ts) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".mts",
  ".mjs",
  ".js",
  ".tsx",
  "/index.ts",
  "/index.mjs",
  "/index.js",
];

/**
 * Resolve a relative import the way tsx and Node would for these scripts: the
 * path as written, then with a script extension, then a `.js` spelling
 * swapped for its `.ts` source.
 *
 * @param {string} fromFile absolute path of the importing file
 * @param {string} specifier a `./` or `../` specifier
 * @param {(p: string) => boolean} exists
 * @returns {string | null} absolute path, or null when nothing matches
 */
export function resolveRelative(fromFile, specifier, exists) {
  const base = resolve(dirname(fromFile), specifier);
  const bases = [base];
  if (/\.m?js$/.test(base))
    bases.push(base.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts"));
  for (const b of bases) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = b + suffix;
      if (SCRIPT_FILE.test(candidate) || candidate.endsWith(".tsx")) {
        if (exists(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Every package the entries import at run time, following relative imports
 * into the files beside them. Each package is reported once, with the first
 * file that imports it, so a message can point at a real line of code.
 *
 * `within`, when given, keeps the walk inside one repo-relative directory.
 * The root sweep passes `tools/scripts`: a file under `packages/database`
 * that a root script happens to reach resolves its imports through its own
 * package, which declares them, so it is not the root's to declare.
 *
 * @param {string} repoRoot
 * @param {string[]} entries repo-relative paths
 * @param {{ read: (p: string) => string, exists: (p: string) => boolean, ts: typeof import("typescript"), within?: string }} io
 * @returns {Map<string, string>} package name -> repo-relative importing file
 */
export function packagesImportedBy(
  repoRoot,
  entries,
  { read, exists, ts, within },
) {
  const packages = new Map();
  const inScope = (abs) => {
    if (!within) return true;
    const rel = relative(resolve(repoRoot, within), abs);
    return rel !== "" && !rel.startsWith("..");
  };
  const queue = entries
    .map((e) => resolve(repoRoot, e))
    .filter((abs) => exists(abs) && inScope(abs));
  const visited = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of runtimeSpecifiers(read(file), file, ts)) {
      if (spec.startsWith(".")) {
        const next = resolveRelative(file, spec, exists);
        if (next && inScope(next)) queue.push(next);
        continue;
      }
      if (spec.startsWith("/") || isBuiltin(spec)) continue;
      const name = packageName(spec);
      if (!packages.has(name)) packages.set(name, relative(repoRoot, file));
    }
  }
  return packages;
}

/**
 * The `run:` commands in a lefthook config, by hook and command name. A plain
 * line reader, because the repository has no YAML parser at the root and the
 * file's shape is fixed: `<hook>:` at column 0, `<command>:` under
 * `commands:`, and a one-line `run:` beneath it.
 *
 * @param {string} text lefthook.yml
 * @returns {{ hook: string, command: string, run: string }[]}
 */
export function lefthookRuns(text) {
  const runs = [];
  let hook = null;
  let command = null;
  let commandIndent = -1;
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const top = /^([A-Za-z][\w-]*):\s*$/.exec(line);
    if (top) {
      hook = top[1];
      command = null;
      commandIndent = -1;
      continue;
    }
    const key = /^(\s+)([\w-]+):\s*(.*)$/.exec(line);
    if (!key || !hook) continue;
    const indent = key[1].length;
    if (key[2] === "commands") {
      commandIndent = indent + 2;
      continue;
    }
    if (indent === commandIndent) {
      command = key[2];
      continue;
    }
    if (key[2] === "run" && command && indent > commandIndent) {
      runs.push({ hook, command, run: key[3].trim() });
    }
  }
  return runs;
}

/**
 * The directory a package would be installed in when `fromDir` looks it up,
 * walking up to the repository root the way Node's resolver does. Null when no
 * `node_modules/<name>/package.json` exists on that walk.
 *
 * @param {string} name package name
 * @param {string} fromDir absolute directory of the importing file
 * @param {string} repoRoot
 * @param {(p: string) => boolean} exists
 * @returns {string | null}
 */
export function installedPackageDir(name, fromDir, repoRoot, exists) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (exists(join(candidate, "package.json"))) return candidate;
    if (dir === repoRoot) return null;
    const parent = dirname(dir);
    if (parent === dir || relative(repoRoot, parent).startsWith(".."))
      return null;
    dir = parent;
  }
}
